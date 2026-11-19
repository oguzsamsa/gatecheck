/**
 * Which countries each region covers, for eligibility. Membership is three-valued on
 * purpose: "Europe" certainly covers Germany and certainly not Brazil, but whether a
 * company hiring "in Europe" means Türkiye or Georgia is genuinely unclear. Those
 * `contested` members are what turn a region match into `unknown` rather than a guess in
 * either direction.
 *
 * Sources: UN M49 for continents; the EU's 27 member states; common industry usage for
 * the business regions (EMEA, APAC, LATAM, MENA).
 */
import type { CountryCode } from '../geo/countries.ts';
import { COUNTRY_NAMES } from '../geo/countries.data.ts';
import type { Region } from '../geo/regions.ts';

export type Coverage = 'yes' | 'no' | 'contested';

const codes = (list: string) => list.split(' ') as CountryCode[];

const EU = codes(
  'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE',
);

/** UN M49 Europe, plus Cyprus (an EU member M49 files under Western Asia). */
const EUROPE = [
  ...EU,
  ...codes('AX AL AD BY BA FO GI GG VA IS IM JE XK LI MD MC ME MK NO RU SM RS SJ CH UA GB'),
];
/** Transcontinental or Council-of-Europe states that "Europe" may or may not mean. */
const EUROPE_CONTESTED = codes('TR GE AM AZ KZ');

const MIDDLE_EAST = codes('AE BH CY EG IL IQ IR JO KW LB OM PS QA SA SY TR YE');

const AFRICA = codes(
  'DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY ' +
    'MG MW ML MR MU YT MA MZ NA NE NG RE RW SH ST SN SC SL SO ZA SS SD TZ TG TN UG EH ZM ZW',
);

const MENA = codes('DZ BH EG IR IQ IL JO KW LB LY MA OM PS QA SA SY TN AE YE EH');

const LATAM = codes('AR BO BR CL CO CR CU DO EC SV GT HN MX NI PA PY PE PR UY VE');

const CARIBBEAN_AND_OTHER_AMERICAS = codes(
  'AI AG AW BS BB BZ BM BQ VG KY CW DM GD GP GY HT JM MQ MS KN LC MF PM VC SX SR TT TC VI ' +
    'BL FK GF GL',
);

const APAC = codes(
  'AU NZ CN JP KR KP TW HK MO SG MY ID TH VN PH KH LA MM BN TL MN IN PK BD LK NP BT MV ' +
    'FJ PG SB VU WS TO KI TV NR PW FM MH NC PF GU MP AS CK NU TK WF NF CX CC',
);

const ALL = Object.keys(COUNTRY_NAMES) as CountryCode[];

const MEMBERSHIP: Record<Region, { yes: CountryCode[]; contested?: CountryCode[] }> = {
  WORLDWIDE: { yes: ALL },
  EU: { yes: EU },
  EUROPE: { yes: EUROPE, contested: EUROPE_CONTESTED },
  // Europe, the Middle East and Africa together leave no doubt about the edge cases.
  EMEA: { yes: [...EUROPE, ...EUROPE_CONTESTED, ...MIDDLE_EAST, ...AFRICA] },
  MENA: { yes: MENA, contested: codes('TR SD MR DJ') },
  NORTH_AMERICA: { yes: codes('US CA'), contested: codes('MX') },
  LATAM: { yes: LATAM },
  AMERICAS: { yes: [...codes('US CA'), ...LATAM, ...CARIBBEAN_AND_OTHER_AMERICAS] },
  APAC: { yes: APAC },
};

const INDEX = new Map(
  Object.entries(MEMBERSHIP).map(([region, m]) => [
    region as Region,
    { yes: new Set(m.yes), contested: new Set(m.contested ?? []) },
  ]),
);

export function regionCovers(region: Region, country: CountryCode): Coverage {
  const m = INDEX.get(region);
  if (!m) return 'no';
  if (m.yes.has(country)) return 'yes';
  return m.contested.has(country) ? 'contested' : 'no';
}
