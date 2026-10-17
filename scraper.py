import httpx
from bs4 import BeautifulSoup
from datetime import datetime, date
from models import Stage
from typing import List, Optional
import logging
import re

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

DATE_RE = r"\d{1,2}\s+[A-Za-z]+\s+\d{4}"
DATE_RANGE_RE = re.compile(rf"({DATE_RE})\s+To\s+({DATE_RE})")
DISTANCE_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*km", re.I)
BOOKING_LINK_RE = re.compile(r"/booking/(\d+)")


class LoginError(Exception):
    pass


class CaminoScraper:
    def __init__(self):
        self.base_url = "https://core.caminoways.com/client"

    async def scrape_stages(self, email: str, password: str, include_quotes: bool = False) -> List[Stage]:
        """Scrape one Stage per walking day from the confirmed bookings (and, if asked, the quotes)"""
        stages: List[Stage] = []
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"}

        async with httpx.AsyncClient(follow_redirects=True, timeout=30, headers=headers) as client:
            await self._login(client, email, password)
            logger.info("Successfully logged in")

            bookings = [(booking_id, "confirmed") for booking_id in await self._list_booking_ids(client, "my-bookings")]
            if include_quotes:
                confirmed = {booking_id for booking_id, _ in bookings}
                bookings += [(booking_id, "quote") for booking_id in await self._list_booking_ids(client, "my-quote-bookings")
                             if booking_id not in confirmed]
            logger.info(f"Found {len(bookings)} bookings to process")

            for idx, (booking_id, status) in enumerate(bookings):
                try:
                    logger.info(f"Processing {status} {idx+1}/{len(bookings)}: {booking_id}")
                    response = await client.get(f"{self.base_url}/booking/{booking_id}")
                    response.raise_for_status()

                    booking_stages = self.parse_booking_html(response.text, booking_id, status)
                    stages.extend(booking_stages)
                    trip_name = booking_stages[0].trip_name if booking_stages else "?"
                    logger.info(f"✓ Extracted {len(booking_stages)} stages for trip: {trip_name}")
                except Exception as e:
                    logger.error(f"✗ Error processing booking {booking_id}: {e}", exc_info=True)
                    continue

        logger.info(f"Total stages extracted: {len(stages)}")
        return stages

    async def _list_booking_ids(self, client: httpx.AsyncClient, path: str, max_pages: int = 20) -> List[str]:
        """Booking numbers on one of the portal's lists (confirmed, quotes, ...), following its pages"""
        ids: List[str] = []
        pending, seen = [f"{self.base_url}/{path}"], set()
        while pending and len(seen) < max_pages:
            url = pending.pop(0)
            if url in seen:
                continue
            seen.add(url)
            response = await client.get(url)
            response.raise_for_status()
            ids += [i for i in BOOKING_LINK_RE.findall(response.text) if i not in ids]
            # Pagination links look like <path>?page=2
            pending += [f"{self.base_url}/{path}?page={n}" for n in sorted({int(n) for n in re.findall(rf"{path}\?page=(\d+)", response.text)})]
        return ids

    async def _login(self, client: httpx.AsyncClient, email: str, password: str):
        """Log in through the Laravel form (CSRF token + session cookie)"""
        response = await client.get(f"{self.base_url}/login")
        response.raise_for_status()
        token = re.search(r'name="_token"[^>]*value="([^"]+)"', response.text)
        if not token:
            raise LoginError("Could not find the login form's CSRF token")

        response = await client.post(f"{self.base_url}/login", data={
            "_token": token.group(1),
            "email": email,
            "password": password,
            "remember_me": "0",
        })
        response.raise_for_status()

        # A failed login redirects back to the login page with a validation message
        if str(response.url).rstrip("/").endswith("/login"):
            message = self._form_error(response.text)
            raise LoginError(message or "Login failed - check your email and password")

    @staticmethod
    def _form_error(html: str) -> Optional[str]:
        soup = BeautifulSoup(html, "lxml")
        error = soup.select_one(".invalid-feedback, .alert-danger, .text-danger:not(:empty)")
        text = error.get_text(" ", strip=True) if error else ""
        return text if len(text) > 1 else None

    # ------------------------------------------------------------------
    # Parsing (pure functions, no network)
    # ------------------------------------------------------------------

    def parse_booking_html(self, html: str, booking_id: str, status: str = "confirmed") -> List[Stage]:
        """Turn a booking (or quote) page into one Stage per walking day"""
        soup = BeautifulSoup(html, "lxml")

        trip_name = self._extract_trip_name(soup)
        days = self._parse_itinerary(soup)
        hotels = self._parse_hotels(soup)
        logger.info(f"Found {len(days)} itinerary days and {len(hotels)} hotels")

        stages = []
        previous = None  # the day we woke up in, i.e. the previous night's stop
        for day in days:
            if previous is not None and day["distance"] > 0:
                start_hotel = self._find_hotel(hotels, previous["location"], check_out=day["date"])
                end_hotel = self._find_hotel(hotels, day["location"], check_in=day["date"])
                stages.append(Stage(
                    name=f"{previous['location']} to {day['location']}",
                    trip_name=trip_name,
                    booking_id=booking_id,
                    status=status,
                    start_location=previous["location"],
                    end_location=day["location"],
                    start_hotel=start_hotel["name"] if start_hotel else "",
                    end_hotel=end_hotel["name"] if end_hotel else "",
                    standard_distance=day["distance"],
                    actual_distance=day["distance"],
                    date_walked=day["date"],
                    is_completed=status == "confirmed" and day["date"] < date.today(),  # a quote is never "walked"
                    description=day["description"],
                    caminoways={
                        "service_level": day["service_level"],
                        "nights": day["nights"],
                        "included": day["included"],
                        "services": [],
                        "start_hotel": self._hotel_details(start_hotel),
                        "end_hotel": self._hotel_details(end_hotel),
                    },
                ))
            # Entries with no distance (arrival night, transfers back) don't move us along the route,
            # except for the very first entry which is where the walk starts
            if previous is None or day["distance"] > 0:
                previous = day

        self._attach_services(stages, self._parse_services(soup))
        return stages

    def _extract_trip_name(self, soup: BeautifulSoup) -> str:
        """Build a name like 'Logrono to Burgos (Oct 2026)' from the 'From <date> (<town>) To <date> (<town>)' header"""
        for heading in soup.find_all(["h1", "h2", "h3"]):
            text = heading.get_text(" ", strip=True)
            match = re.match(rf"From\s+({DATE_RE})\s+\((.+?)\)\s+To\s+({DATE_RE})\s+\((.+?)\)", text)
            if match:
                start = self._parse_date(match.group(1))
                return f"{match.group(2)} to {match.group(4)} ({start.strftime('%b %Y')})"
        return "Trip"

    def _parse_itinerary(self, soup: BeautifulSoup) -> List[dict]:
        itinerary = soup.find(id="itinerary")
        if itinerary is None:
            return []

        days = []
        for card in itinerary.select("div.section-card-itinerary-accordion"):
            date_el = card.select_one(".itinerary-advanced-badge span")
            location_el = card.select_one(".accordion-button .heading-4")
            if not date_el or not location_el:
                continue

            date_match = re.search(DATE_RE, date_el.get_text(" ", strip=True))
            if not date_match:
                continue

            distance = 0.0
            distance_el = card.select_one(".accordion-button .heading-5")
            if distance_el:
                distance_match = DISTANCE_RE.search(distance_el.get_text(" ", strip=True))
                if distance_match:
                    distance = float(distance_match.group(1).replace(",", "."))

            # Badges: one with text is the service level (ST / SU), the icon-only ones are inclusions
            service_level, included = None, []
            for badge in card.select(".accordion-service-badge"):
                title = (badge.get("data-bs-title") or "").strip()
                code = badge.get_text(strip=True)
                if code:
                    service_level = {"code": code, "name": title or code}
                elif title:
                    included.append(title)

            nights_match = re.search(r"(\d+)\s+Nights?", card.select_one(".itinerary-advanced-badge").get_text(" ", strip=True))

            description_el = card.select_one(".rte-content")
            days.append({
                "service_level": service_level,
                "included": included,
                "nights": int(nights_match.group(1)) if nights_match else None,
                "date": self._parse_date(date_match.group(0)),
                "location": location_el.get_text(" ", strip=True),
                "distance": distance,
                "description": description_el.get_text(" ", strip=True) if description_el else None,
            })
        return days

    def _parse_hotels(self, soup: BeautifulSoup) -> List[dict]:
        """Accommodation entries from the services section: location, stay dates, hotel name and address"""
        services = soup.find(id="services")
        if services is None:
            return []

        hotels = []
        for label in services.find_all(string=re.compile(r"^\s*Location:\s*")):
            # The smallest ancestor holding the stay dates, the hotel heading and the location
            card = label.parent
            while card is not None and not (card.find("h4") and DATE_RANGE_RE.search(card.get_text(" ", strip=True))):
                card = card.parent
            if card is None:
                continue

            text = card.get_text(" ", strip=True)
            dates = DATE_RANGE_RE.search(text)
            location = re.search(r"Location:\s*(.+?)(?=\s+(?:Bed|Hotel|Room|See Hotel)|$)", text)
            name = card.find("h4")
            address = card.select_one(".icon-pin")
            phone = card.select_one('a[href^="tel:"]')
            map_link = next((a["href"] for a in card.find_all("a", href=True) if "Hotel On Map" in a.get_text()), None)
            board = card.find("h3")
            reservation = re.search(r"Reservation number:\s*(\S+)", text)
            hotels.append({
                "phone": phone.get_text(strip=True) if phone else None,
                "map_url": map_link,
                "board": board.get_text(" ", strip=True) if board else None,
                "reservation": reservation.group(1) if reservation else None,
                "check_in": self._parse_date(dates.group(1)),
                "check_out": self._parse_date(dates.group(2)),
                "location": location.group(1).strip() if location else "",
                "name": name.get_text(" ", strip=True),
                "address": address.find_next("div").get_text(" ", strip=True) if address else None,
            })
        return hotels

    @staticmethod
    def _hotel_details(hotel: Optional[dict]) -> Optional[dict]:
        """The parts of a hotel entry worth showing, as plain JSON-friendly values"""
        if not hotel:
            return None
        return {
            "name": hotel["name"],
            "address": hotel["address"],
            "phone": hotel["phone"],
            "map_url": hotel["map_url"],
            "board": hotel["board"],
            "reservation": hotel["reservation"],
            "check_in": hotel["check_in"].isoformat(),
            "check_out": hotel["check_out"].isoformat(),
        }

    def _parse_services(self, soup: BeautifulSoup) -> List[dict]:
        """Luggage transfers, passenger transfers and other extras from the services section"""
        services_el = soup.find(id="services")
        if services_el is None:
            return []

        services, seen = [], set()
        for card in services_el.select("div.section-card"):
            title_el = card.find("h3")
            if title_el is None or any("Hotel On Map" in a.get_text() for a in card.find_all("a")):
                continue  # not a service card, or it's a hotel (handled by _parse_hotels)

            # The stay dates sit in a header just before the card
            header = card.find_previous(string=DATE_RANGE_RE)
            dates = DATE_RANGE_RE.search(header) if header else None
            if not dates:
                continue

            # "Bags:", "Pax:", "Pickup:" and "Dropoff:" are a label span followed by a value span
            fields = {}
            for span in card.find_all("span"):
                label = span.get_text(" ", strip=True)
                value = span.find_next_sibling("span")
                if label.endswith(":") and len(label) < 20 and value is not None:
                    text = re.sub(r"^\s*-\s*", "", value.get_text(" ", strip=True))
                    fields[label[:-1].strip().lower()] = text

            notes = []
            for label in card.find_all(string=re.compile(r"Note:\s*$")):
                body = label.parent.find_next_sibling()
                text = " ".join(p.get_text(" ", strip=True) for p in body.find_all("p")) if body else ""
                text = re.sub(r"\s*(Click to Expand|Learn More)\s*", " ", text).strip()
                if text:
                    notes.append({"label": label.strip(" :"), "text": text})

            provider, pin, phone = card.find("h4"), card.select_one(".icon-pin"), card.select_one('a[href^="tel:"]')
            title = title_el.get_text(" ", strip=True)
            service = {
                "kind": self._service_kind(title),
                "title": title,
                "provider": provider.get_text(" ", strip=True) if provider else None,
                "address": pin.find_next("div").get_text(" ", strip=True) if pin else None,
                "phone": phone.get_text(strip=True) if phone else None,
                "from": self._parse_date(dates.group(1)),
                "to": self._parse_date(dates.group(2)),
                "bags": fields.get("bags"),
                "pax": fields.get("pax"),
                "pickup": fields.get("pickup"),
                "dropoff": fields.get("dropoff"),
                "notes": notes,
            }
            # Passenger names and emails are left out on purpose: only what's needed to use the service
            key = (service["title"], service["provider"], service["pickup"], service["dropoff"], service["from"], service["to"])
            if key not in seen:
                seen.add(key)
                services.append(service)
        return services

    @staticmethod
    def _service_kind(title: str) -> str:
        lowered = title.lower()
        if "luggage" in lowered:
            return "luggage"
        if "passenger" in lowered or "people" in lowered or "transfer" in lowered:
            return "passenger"
        if "dinner" in lowered:
            return "dinner"
        return "other"

    @staticmethod
    def _attach_services(stages: List[Stage], services: List[dict]):
        """Give each stage the services on its day. One that falls on no walking day (a transfer after the last
        stage, say) goes to the nearest stage so it isn't lost."""
        if not stages:
            return
        for service in services:
            on_day = [st for st in stages if service["from"] <= st.date_walked <= service["to"]]
            targets = on_day or [min(stages, key=lambda st: (abs((st.date_walked - service["from"]).days), -st.date_walked.toordinal()))]
            for stage in targets:
                stage.caminoways["services"].append({
                    **service, "from": service["from"].isoformat(), "to": service["to"].isoformat()})

    def _find_hotel(self, hotels: List[dict], location: str, check_in: date = None, check_out: date = None) -> Optional[dict]:
        wanted = self._normalise(location)
        for hotel in hotels:
            if check_in and hotel["check_in"] != check_in:
                continue
            if check_out and hotel["check_out"] != check_out:
                continue
            if self._normalise(hotel["location"]) == wanted:
                return hotel
        return None

    @staticmethod
    def _normalise(text: str) -> str:
        return re.sub(r"\W+", " ", text).strip().lower()

    def _parse_date(self, date_str: str) -> date:
        """Parse date from various formats"""
        if not date_str:
            return date.today()

        date_str = date_str.strip()
        formats = [
            "%d %B %Y",
            "%d %b %Y",
            "%Y-%m-%d",
            "%d/%m/%Y",
            "%d-%m-%Y",
            "%B %d, %Y",
            "%b %d, %Y",
        ]

        for fmt in formats:
            try:
                return datetime.strptime(date_str, fmt).date()
            except ValueError:
                continue

        logger.warning(f"Could not parse date: {date_str}")
        return date.today()
