/**
 * A small gazetteer for labels that name only a city ("Dublin", "Istanbul", "Bengaluru").
 *
 * Deliberately curated rather than exhaustive: it covers the hubs job boards actually use,
 * and it leaves out names shared by notable cities in different countries (Cambridge,
 * Hyderabad, San Jose, Santiago, Valencia, Birmingham, Portland, Lima…) — for those a
 * wrong country is worse than no answer, which keeps the claim unresolved and the posting
 * in `unknown`. Cities are separated by `|`, alternate spellings of one city by `/`; the first
 * spelling is the display name.
 */
import type { CountryCode } from './countries.ts';
import { foldPlaceText } from './text.ts';

const CITIES: Partial<Record<CountryCode, string>> = {
  TR: 'Istanbul/İstanbul|Ankara|Izmir/İzmir|Bursa|Antalya|Eskisehir/Eskişehir|Kocaeli',
  US:
    'New York/New York City/NYC|San Francisco/SF/San Francisco Bay Area/Bay Area|Los Angeles|' +
    'Seattle|Austin|Boston|Chicago|Denver|Atlanta|Miami|Washington DC/Washington D.C.|Dallas|' +
    'Houston|Philadelphia|San Diego|Palo Alto|Mountain View|Menlo Park|Sunnyvale|Redwood City|' +
    'Pittsburgh|Phoenix|Salt Lake City|Minneapolis|Detroit|Raleigh|Nashville|Boulder|Ann Arbor|' +
    'Brooklyn|Santa Monica|Oakland|Cupertino|Irvine|South San Francisco',
  CA: 'Toronto|Vancouver|Montreal/Montréal|Ottawa|Calgary|Edmonton',
  GB: 'London|Manchester|Edinburgh|Glasgow|Bristol|Leeds|Belfast|Cardiff',
  IE: 'Dublin|Cork|Galway',
  DE:
    'Berlin|Munich/München|Hamburg|Frankfurt/Frankfurt am Main|Cologne/Köln|Stuttgart|' +
    'Düsseldorf|Leipzig',
  FR: 'Paris|Lyon|Toulouse|Marseille|Nantes|Lille|Bordeaux',
  NL: 'Amsterdam|Rotterdam|Utrecht|The Hague/Den Haag|Eindhoven',
  ES: 'Madrid|Barcelona|Seville/Sevilla|Malaga/Málaga|Bilbao',
  PT: 'Lisbon/Lisboa|Porto',
  IT: 'Milan/Milano|Rome/Roma|Turin/Torino|Bologna',
  CH: 'Zurich/Zürich|Geneva/Genève|Basel|Lausanne',
  AT: 'Vienna/Wien',
  BE: 'Brussels/Bruxelles|Antwerp|Ghent',
  DK: 'Copenhagen/København|Aarhus',
  SE: 'Stockholm|Gothenburg/Göteborg|Malmo/Malmö',
  NO: 'Oslo',
  FI: 'Helsinki|Espoo|Tampere',
  PL: 'Warsaw/Warszawa|Krakow/Kraków|Wroclaw/Wrocław|Gdansk/Gdańsk|Poznan/Poznań|Lodz/Łódź',
  CZ: 'Prague/Praha|Brno',
  HU: 'Budapest',
  RO: 'Bucharest/București/Bukarest|Cluj-Napoca/Cluj',
  BG: 'Sofia',
  GR: 'Athens|Thessaloniki',
  RS: 'Belgrade/Beograd/Belgrad|Novi Sad',
  HR: 'Zagreb',
  SI: 'Ljubljana',
  SK: 'Bratislava',
  EE: 'Tallinn/Talinn|Tartu',
  LV: 'Riga',
  LT: 'Vilnius|Kaunas',
  UA: 'Kyiv/Kiev|Lviv|Kharkiv',
  CY: 'Limassol|Nicosia|Larnaca',
  IS: 'Reykjavik',
  BA: 'Sarajevo',
  AL: 'Tirana',
  MK: 'Skopje',
  GE: 'Tbilisi|Batumi',
  AM: 'Yerevan',
  AZ: 'Baku',
  KZ: 'Almaty|Astana',
  IL: 'Tel Aviv/Tel Aviv-Yafo|Jerusalem|Haifa',
  AE: 'Dubai|Abu Dhabi',
  SA: 'Riyadh|Jeddah',
  QA: 'Doha',
  EG: 'Cairo/Kairo',
  MA: 'Rabat|Casablanca',
  TN: 'Tunis',
  PK: 'Islamabad|Karachi|Lahore',
  IN: 'Bengaluru/Bangalore|Mumbai|New Delhi/Delhi|Chennai|Pune|Gurugram/Gurgaon|Noida|Kolkata',
  JP: 'Tokyo|Osaka|Kyoto',
  KR: 'Seoul|Busan',
  CN: 'Beijing|Shanghai|Shenzhen|Hangzhou|Guangzhou',
  TW: 'Taipei',
  AU: 'Sydney|Melbourne|Brisbane|Adelaide',
  NZ: 'Auckland|Wellington',
  ID: 'Jakarta',
  VN: 'Ho Chi Minh City|Hanoi',
  TH: 'Bangkok',
  PH: 'Manila',
  MY: 'Kuala Lumpur',
  BR:
    'São Paulo/Sao Paulo|Rio de Janeiro|Belo Horizonte|Florianópolis/Florianopolis|Curitiba|' +
    'Porto Alegre',
  AR: 'Buenos Aires',
  MX: 'Mexico City/Ciudad de México|Guadalajara|Monterrey',
  CO: 'Bogotá/Bogota|Medellín/Medellin',
  UY: 'Montevideo',
  ZA: 'Cape Town|Johannesburg',
  NG: 'Lagos',
  KE: 'Nairobi',
  NP: 'Kathmandu',
};

export interface City {
  country: CountryCode;
  /** Display name: the first spelling listed for the city. */
  name: string;
}

const BY_FOLDED_NAME = new Map<string, City>();
for (const [country, list] of Object.entries(CITIES) as [CountryCode, string][]) {
  for (const group of list.split('|')) {
    const [name = group, ...rest] = group.split('/');
    for (const spelling of [name, ...rest]) {
      BY_FOLDED_NAME.set(foldPlaceText(spelling), { country, name });
    }
  }
}

export function cityByFoldedName(folded: string): City | null {
  return BY_FOLDED_NAME.get(folded) ?? null;
}
