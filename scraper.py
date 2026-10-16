from playwright.async_api import async_playwright, Page
from datetime import datetime, date
from models import Stage
from typing import List, Optional
import logging
import re

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class CaminoScraper:
    def __init__(self):
        self.base_url = "https://core.caminoways.com/client"

    async def scrape_stages(self, email: str, password: str) -> List[Stage]:
        """Scrape stages from caminoways.com"""
        stages = []

        async with async_playwright() as p:
            browser = await p.chromium.launch()
            page = await browser.new_page()

            try:
                await page.goto(self.base_url)
                logger.info("Navigated to CaminoWays login")

                await page.fill('input[type="email"]', email)
                await page.fill('input[type="password"]', password)
                await page.click('button[type="submit"]')

                await page.wait_for_load_state("networkidle", timeout=15000)
                logger.info("Successfully logged in")

                await page.goto(f"{self.base_url}/my-bookings", wait_until="networkidle", timeout=20000)
                logger.info("Navigated to my-bookings")

                booking_links = []
                link_elements = await page.locator('a[href*="/booking/"]').all()

                for link in link_elements:
                    href = await link.get_attribute('href')
                    if href and '/booking/' in href:
                        booking_links.append(href)

                booking_links = list(set(booking_links))
                logger.info(f"Found {len(booking_links)} bookings to process")

                for idx, booking_link in enumerate(booking_links):
                    try:
                        logger.info(f"Processing booking {idx+1}/{len(booking_links)}: {booking_link}")
                        await page.goto(booking_link, wait_until="networkidle", timeout=20000)

                        trip_name = await self._extract_trip_name(page)
                        booking_stages = await self._extract_stages_from_booking(page)

                        for stage in booking_stages:
                            stage.trip_name = trip_name

                        stages.extend(booking_stages)
                        logger.info(f"✓ Extracted {len(booking_stages)} stages for trip: {trip_name}")

                    except Exception as e:
                        logger.error(f"✗ Error processing booking: {e}", exc_info=True)
                        continue

            finally:
                await browser.close()

        logger.info(f"Total stages extracted: {len(stages)}")
        return stages

    async def _extract_trip_name(self, page: Page) -> str:
        """Extract the trip name from the booking page header"""
        try:
            # Look for the trip reference in the header (usually something like "CWX112354-JonPrideaux")
            trip_ref = await page.locator(r'text=/CWX\d+-/').first.text_content()
            if trip_ref:
                return trip_ref.strip()

            # Fallback: try to get from heading
            heading = await page.locator('h2').first.text_content()
            if heading:
                return heading.strip()

            return "Trip"
        except:
            return "Trip"

    async def _extract_stages_from_booking(self, page: Page) -> List[Stage]:
        """Extract walking stages from a booking page"""
        stages = []

        try:
            # Get the itinerary section text
            itinerary_html = await page.locator('[id="itinerary"]').inner_html()

            # Extract stage information from the itinerary
            stage_list = self._parse_itinerary_html(itinerary_html)
            logger.info(f"Found {len(stage_list)} potential stages in itinerary")

            # Get services section for hotel and transfer details
            services_html = await page.locator('[id="services"]').inner_html()
            hotel_map = self._extract_hotels_from_services(services_html)
            logger.info(f"Found {len(hotel_map)} hotels/services")

            # Combine stage and hotel information
            for i, stage_info in enumerate(stage_list):
                stage = Stage(
                    name=f"{stage_info['location']}",
                    start_location=stage_info.get('prev_location') or '',
                    end_location=stage_info['location'],
                    start_hotel=hotel_map.get(i, {}).get('hotel', ''),
                    end_hotel=hotel_map.get(i + 1, {}).get('hotel', ''),
                    start_hotel_lat=None,
                    start_hotel_lon=None,
                    end_hotel_lat=None,
                    end_hotel_lon=None,
                    standard_distance=stage_info.get('distance', 0.0),
                    actual_distance=stage_info.get('distance', 0.0),
                    date_walked=stage_info['date'],
                    is_completed=stage_info['date'] < date.today()
                )
                stages.append(stage)

        except Exception as e:
            logger.error(f"Error extracting stages: {e}", exc_info=True)

        return stages

    def _parse_itinerary_html(self, html: str) -> List[dict]:
        """Parse itinerary HTML to extract walking stages"""
        stages = []

        # Look for stage entries - they contain dates, locations, and distances
        # Pattern: Date like "01 May 2025", location name, distance like "25km"

        # Find all text sections that look like stage entries
        date_pattern = r'(\d{1,2}\s+\w+\s+\d{4})'
        distance_pattern = r'(\d+(?:\.\d+)?)\s*km'

        dates = re.findall(date_pattern, html)
        distances = re.findall(distance_pattern, html)

        # Extract location names - they appear near dates in the HTML
        # Look for text between date and distance
        stage_sections = re.split(r'<div class="section-card">', html)

        location_pattern = r'<h\d[^>]*>([^<]+(?:(?!<h\d).)*?(?:\d+\s*km)?[^<]*)</h\d>'

        prev_location = None
        for section in stage_sections[1:]:  # Skip first empty split
            # Get text content
            text_content = re.sub(r'<[^>]+>', '', section)
            lines = [line.strip() for line in text_content.split('\n') if line.strip()]

            if len(lines) < 2:
                continue

            # Extract date
            date_match = re.search(date_pattern, text_content)
            if not date_match:
                continue

            date_str = date_match.group(1)
            walked_date = self._parse_date(date_str)

            # Extract location (usually first meaningful word after date removal)
            location = None
            for line in lines:
                # Skip lines with common non-location keywords
                if any(skip in line.lower() for skip in ['luggage', 'transfer', 'breakfast', 'dinner', 'service', 'note', 'included', 'pax']):
                    continue
                if len(line) > 2 and line[0].isupper():
                    location = line.split('(')[0].strip()
                    break

            if not location:
                location = lines[0]

            # Extract distance
            distance = 0.0
            distance_match = re.search(distance_pattern, text_content)
            if distance_match:
                distance = float(distance_match.group(1))

            # Only add if it has a distance (indicates a walking stage, not a transfer)
            if distance > 0 and location:
                stages.append({
                    'location': location,
                    'prev_location': prev_location,
                    'distance': distance,
                    'date': walked_date
                })
                prev_location = location

        return stages

    def _extract_hotels_from_services(self, html: str) -> dict:
        """Extract hotel information from services section"""
        hotels = {}

        # Look for hotel headings and their dates
        hotel_pattern = r'<h\d[^>]*>([^<]*(?:Hotel|Parador|Posada|Residencia|Inn|Casa)[^<]*)</h\d>'
        hotels_found = re.findall(hotel_pattern, html, re.IGNORECASE)

        # Also look for hotel names in general headings
        if not hotels_found:
            # Fallback: look for any heading that might be a hotel
            hotel_pattern = r'<h\d[^>]*>([^<]{10,})</h\d>'
            potential = re.findall(hotel_pattern, html)
            # Filter for likely hotel names
            hotels_found = [h for h in potential if not any(skip in h.lower() for skip in ['luggage', 'passenger', 'price', 'payment', 'itinerary'])][:10]

        for idx, hotel in enumerate(hotels_found):
            hotels[idx] = {
                'hotel': hotel.strip(),
                'address': '',
                'lat': None,
                'lon': None
            }

        return hotels

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
