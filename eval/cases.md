# Eval cases: person-search results

Fixture: `peopleSearch(50, 11)` from bench/people.ts (synthetic, shaped like Crustdata's person search docs).
Expected answers are computed in code from the fixture. `left-out` cases: the full-JSON arm should answer the school;
arms that keep only the query's fields should answer `NOT_SHOWN` (education isn't in their data).

| id | type | question | expected |
|---|---|---|---|
| title-1 | lookup | What is Lucas Rossi's current title? | Founding Engineer |
| title-2 | lookup | What is Omar Okafor's current title? | VP Engineering |
| title-3 | lookup | What is Liam Kim's current title? | Staff Software Engineer |
| title-4 | lookup | What is Kenji Shah's current title? | Head of Growth |
| company-1 | lookup | Which company does Kenji Chen currently work at? | Tidal Commerce |
| company-2 | lookup | Which company does Ethan Haddad currently work at? | Granite Security |
| company-3 | lookup | Which company does Ananya Nguyen currently work at? | Bluefin Data |
| company-4 | lookup | Which company does Ethan Kim currently work at? | Bluefin Data |
| url-1 | copy | What is Priya Haddad's LinkedIn profile URL? Reply with the full URL exactly. | https://www.linkedin.com/in/ACwAAEev4NfYBrF3UMi9hKRd233sWHbSrhsmBgm |
| url-2 | copy | What is Aarav Rossi's LinkedIn profile URL? Reply with the full URL exactly. | https://www.linkedin.com/in/ACwAAjDb8PubdZpYJUkEg5GtsH7klgWV5328CBq |
| url-3 | copy | What is Priya Mehta's LinkedIn profile URL? Reply with the full URL exactly. | https://www.linkedin.com/in/ACwAAAF18FXkscXtO6WtPO2Urc44AMkn5D97Ud3 |
| count-1 | count | How many people on this page are located in San Francisco? Reply with a number. | 9 |
| count-2 | count | How many people on this page are located in London? Reply with a number. | 7 |
| count-3 | count | How many people on this page are located in Bengaluru? Reply with a number. | 6 |
| count-4 | count | How many people on this page are located in Toronto? Reply with a number. | 10 |
| count-5 | count | How many people on this page are located in Austin? Reply with a number. | 7 |
| count-6 | count | How many people on this page are located in Paris? Reply with a number. | 0 |
| filter-1 | filter | List the crustdata_person_id of every person on this page whose current title contains 'Co-Founder' and who are located in San Francisco. Reply with a comma-separated list of ids, or NONE if there are none. | 1169119 |
| filter-2 | filter | List the crustdata_person_id of every person on this page whose current title contains 'Co-Founder'. Reply with a comma-separated list of ids, or NONE if there are none. | 1169119, 1551012, 4651236, 5114211, 6155657, 6687341, 7901767, 8907489 |
| filter-3 | filter | List the crustdata_person_id of every person on this page who currently work at Acme AI. Reply with a comma-separated list of ids, or NONE if there are none. | 1814677, 7445453, 8120341, 9699164 |
| filter-4 | filter | List the crustdata_person_id of every person on this page whose current title starts with 'Head of' and who are located in the United States. Reply with a comma-separated list of ids, or NONE if there are none. | 5962793, 6916539, 8562683, 9221404 |
| filter-5 | filter | List the crustdata_person_id of every person on this page who currently work at Orbital Pay and are located outside India. Reply with a comma-separated list of ids, or NONE if there are none. | 1169119, 2102173, 2239612, 9221404, 9757636 |
| filter-6 | filter | List the crustdata_person_id of every person on this page whose current title is exactly 'VP Engineering'. Reply with a comma-separated list of ids, or NONE if there are none. | 1028895, 2102173, 3210989, 3279296, 6989174, 8120341, 8157306 |
| total-1 | meta | How many people match this search in total, across all pages? Reply with a number. | 12400 |
| school-1 | left-out | Which school did Maya Silva attend? If several, list them comma-separated. | University of Waterloo (full JSON) / NOT_SHOWN (shaped) |
| school-2 | left-out | Which school did Chloe Okafor attend? If several, list them comma-separated. | University of Cambridge, IIT Bombay (full JSON) / NOT_SHOWN (shaped) |
| school-3 | left-out | Which school did Omar Nguyen attend? If several, list them comma-separated. | University of Waterloo, UC Berkeley (full JSON) / NOT_SHOWN (shaped) |
| school-4 | left-out | Which school did Zara Novak attend? If several, list them comma-separated. | MIT (full JSON) / NOT_SHOWN (shaped) |
| school-5 | left-out | Which school did Maya Mehta attend? If several, list them comma-separated. | University of Waterloo (full JSON) / NOT_SHOWN (shaped) |
| school-6 | left-out | Which school did Ethan Nguyen attend? If several, list them comma-separated. | Stanford University (full JSON) / NOT_SHOWN (shaped) |
| headline-1 | partial | What is Isla Rossi's profile headline? Reply with it exactly as written. | Head of Data at Bluefin Data \| Building the future of AI agents (full JSON) / NOT_SHOWN (shaped) |
| headline-2 | partial | What is Omar Larsen's profile headline? Reply with it exactly as written. | Co-Founder & CTO at Granite Security \| Building the future of AI agents (full JSON) / NOT_SHOWN (shaped) |
| hq-1 | partial | In which country is Kenji Novak's current company headquartered? Reply with the country exactly as written in the data. | USA (full JSON) / NOT_SHOWN (shaped) |
| hq-2 | partial | In which country is Liam Cohen's current company headquartered? Reply with the country exactly as written in the data. | Germany (full JSON) / NOT_SHOWN (shaped) |
| past-1 | partial | List the companies Priya Shah worked at before their current job, comma-separated. | Lumen Health, Kestrel Robotics, Acme AI, Tidal Commerce (full JSON) / NOT_SHOWN (shaped) |
| past-2 | partial | List the companies Leah Kim worked at before their current job, comma-separated. | Northwind Labs, Kestrel Robotics, Lumen Health (full JSON) / NOT_SHOWN (shaped) |
