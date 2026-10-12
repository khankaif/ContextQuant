import type { Json } from "../src/shape.ts";

/**
 * Synthetic person-search response shaped like Crustdata's documented `POST /person/search`
 * (docs.crustdata.com, API version 2025-11-01). Field names and nesting follow the docs;
 * every value is made up. Seeded, so the same (n, seed) gives byte-identical output.
 */
export function peopleSearch(n = 25, seed = 42): Json {
  const rand = mulberry32(seed);
  const pickOne = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const hex = (len: number) => Array.from({ length: len }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
  const b62 = (len: number) =>
    Array.from({ length: len }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rand() * 62)]).join("");
  const media = (kind: string) => `https://crustdata-media.s3.us-east-2.amazonaws.com/${kind}/${hex(40)}.jpg`;
  const location = () => {
    const [city, state, country, continent] = pickOne(CITIES);
    return { raw: `${city}, ${state}, ${country}`, city, state, country, continent };
  };
  const role = (title: string) => {
    const [name, site, hq] = pickOne(COMPANIES);
    return {
      name,
      title,
      company_status: rand() < 0.95 ? "active" : null,
      company_website: site,
      company_headquarters_country: hq,
      company_profile_picture_permalink: media("company"),
      business_email_verified: rand() < 0.6,
    };
  };

  const profiles = Array.from({ length: n }, (_, i) => {
    const name = `${pickOne(FIRST)} ${pickOne(LAST)}`;
    const title = pickOne(TITLES);
    const current = role(title);
    return {
      crustdata_person_id: 1_000_000 + Math.floor(rand() * 9_000_000) + i,
      basic_profile: {
        name,
        headline: `${title} at ${current.name} | ${pickOne(HEADLINE_TAILS)}`,
        current_title: title,
        profile_picture_permalink: media("person"),
        location: location(),
      },
      social_handles: {
        professional_network_identifier: { profile_url: `https://www.linkedin.com/in/ACwAA${b62(34)}` },
      },
      experience: {
        employment_details: {
          current: [current],
          past: Array.from({ length: 1 + Math.floor(rand() * 4) }, () => role(pickOne(TITLES))),
        },
      },
      education: {
        schools: Array.from({ length: 1 + Math.floor(rand() * 2) }, () => ({
          school: pickOne(SCHOOLS),
          degree: pickOne(DEGREES),
          location: location(),
          institute_logo_permalink: media("school"),
        })),
      },
    };
  });

  return { profiles, next_cursor: b62(96), total_count: 12_400, total_count_relation: null };
}

// Example query from Crustdata's person search docs.
export const SAMPLE_QUERY = {
  filters: {
    op: "and",
    conditions: [
      { field: "experience.employment_details.current.title", type: "(.)", value: "Co-Founder" },
      { field: "basic_profile.location.full_location", type: "(.)", value: "San Francisco" },
    ],
  },
};

/** Person-search defaults used by the synthetic benchmark fixture. */
export const PEOPLE_BASE = [
  "crustdata_person_id",
  "basic_profile.name",
  "basic_profile.current_title",
  "basic_profile.location.raw",
  "experience.employment_details.current.name",
  "social_handles.professional_network_identifier.profile_url",
];

/** Request fields whose response paths differ in the fixture. */
export const PEOPLE_RENAME: Record<string, string> = {
  "basic_profile.location.full_location": "basic_profile.location.raw",
};

function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Aarav", "Maya", "Liam", "Priya", "Noah", "Sofia", "Ethan", "Zara", "Lucas", "Ananya", "Omar", "Chloe", "Kenji", "Isla", "Mateo", "Leah"];
const LAST = ["Shah", "Chen", "Patel", "Garcia", "Kim", "Nguyen", "Okafor", "Rossi", "Silva", "Cohen", "Mehta", "Novak", "Haddad", "Larsen"];
const TITLES = ["Co-Founder & CEO", "Co-Founder & CTO", "VP Engineering", "Head of Growth", "Staff Software Engineer", "Product Manager", "Founding Engineer", "Director of Sales", "Head of Data", "Chief Revenue Officer"];
const HEADLINE_TAILS = ["Building the future of AI agents", "Ex-Google, Ex-Stripe", "Hiring engineers!", "YC alum", "Angel investor", "Scaling GTM teams"];
const COMPANIES: readonly (readonly [string, string, string])[] = [
  ["Acme AI", "https://acme.ai", "USA"], ["Northwind Labs", "https://northwindlabs.com", "USA"], ["Bluefin Data", "https://bluefin.io", "UK"],
  ["Kestrel Robotics", "https://kestrel.dev", "Germany"], ["Lumen Health", "https://lumenhealth.com", "USA"], ["Orbital Pay", "https://orbitalpay.com", "India"],
  ["Granite Security", "https://granitesec.com", "Israel"], ["Tidal Commerce", "https://tidal.shop", "Canada"],
];
const CITIES: readonly (readonly [string, string, string, string])[] = [
  ["San Francisco", "California", "United States", "North America"], ["New York", "New York", "United States", "North America"],
  ["London", "England", "United Kingdom", "Europe"], ["Bengaluru", "Karnataka", "India", "Asia"], ["Berlin", "Berlin", "Germany", "Europe"],
  ["Austin", "Texas", "United States", "North America"], ["Toronto", "Ontario", "Canada", "North America"],
];
const SCHOOLS = ["Stanford University", "IIT Bombay", "University of Cambridge", "MIT", "University of Waterloo", "TU Munich", "UC Berkeley"];
const DEGREES = ["BS Computer Science", "MBA", "MS Electrical Engineering", "BA Economics", "PhD Machine Learning", "BTech"];
