/** Crustdata person-search defaults used by the fixture and CLI demo. */
export const PEOPLE_BASE = [
  "crustdata_person_id",
  "basic_profile.name",
  "basic_profile.current_title",
  "basic_profile.location.raw",
  "experience.employment_details.current.name",
  "social_handles.professional_network_identifier.profile_url",
];

/** Request fields whose response paths differ. */
export const PEOPLE_RENAME: Record<string, string> = {
  "basic_profile.location.full_location": "basic_profile.location.raw",
};
