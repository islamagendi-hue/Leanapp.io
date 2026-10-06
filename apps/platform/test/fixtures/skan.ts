/**
 * Apple's published example postbacks, with their valid signatures, copied
 * from Apple's documentation (used to test verification against Apple's real key):
 *   https://developer.apple.com/documentation/storekit/verifying-an-install-validation-postback (4.0)
 *   https://developer.apple.com/documentation/storekit/combining-parameters-for-skadnetwork-3-postbacks (3.0)
 *   https://developer.apple.com/documentation/storekit/combining-parameters-for-previous-skadnetwork-postback-versions (2.2)
 *   https://developer.apple.com/documentation/adattributionkit/identifying-the-parameters-in-a-postback (AdAttributionKit, development key)
 * Their app-id is Apple's example 525463029.
 */
export const APPLE_APP_ID = 525463029;

export const skan4Fine = {
  version: "4.0",
  "ad-network-id": "com.example",
  "source-identifier": "5239",
  "app-id": 525463029,
  "transaction-id": "6aafb7a5-0170-41b5-bbe4-fe71dedf1e30",
  redownload: false,
  "source-domain": "example.com",
  "fidelity-type": 1,
  "did-win": true,
  "conversion-value": 63,
  "postback-sequence-index": 0,
  "attribution-signature": "MEUCIGRmSMrqedNu6uaHyhVcifs118R5z/AB6cvRaKrRRHWRAiEAv96ne3dKQ5kJpbsfk4eYiePmrZUU6sQmo+7zfP/1Bxo=",
};

export const skan4Coarse = {
  version: "4.0",
  "ad-network-id": "com.example",
  "source-identifier": "39",
  "app-id": 525463029,
  "transaction-id": "6aafb7a5-0170-41b5-bbe4-fe71dedf1e31",
  redownload: false,
  "source-domain": "example.com",
  "fidelity-type": 1,
  "did-win": true,
  "coarse-conversion-value": "high",
  "postback-sequence-index": 0,
  "attribution-signature": "MEUCIQD4rX6eh38qEhuUKHdap345UbmlzA7KEZ1bhWZuYM8MJwIgMnyiiZe6heabDkGwOaKBYrUXQhKtF3P/ERHqkR/XpuA=",
};

export const skan3Win = {
  version: "3.0",
  "ad-network-id": "example123.skadnetwork",
  "campaign-id": 42,
  "transaction-id": "6aafb7a5-0170-41b5-bbe4-fe71dedf1e28",
  "app-id": 525463029,
  "attribution-signature": "MEYCIQD5eq3AUlamORiGovqFiHWI4RZT/PrM3VEiXUrsC+M51wIhAPMANZA9c07raZJ64gVaXhB9+9yZj/X6DcNxONdccQij",
  redownload: true,
  "source-app-id": 1234567891,
  "fidelity-type": 1,
  "conversion-value": 20,
  "did-win": true,
};

export const skan3Loss = {
  version: "3.0",
  "ad-network-id": "example123.skadnetwork",
  "campaign-id": 42,
  "transaction-id": "f9ac267a-a889-44ce-b5f7-0166d11461f0",
  "app-id": 525463029,
  "attribution-signature": "MEUCIQDDetUtkyc/MiQvVJ5I6HIO1E7l598572Wljot2Onzd4wIgVJLzVcyAV+TXksGNoa0DTMXEPgNPeHCmD4fw1ABXX0g=",
  redownload: true,
  "fidelity-type": 1,
  "did-win": false,
};

export const skan22 = {
  version: "2.2",
  "ad-network-id": "com.example",
  "campaign-id": 42,
  "transaction-id": "6aafb7a5-0170-41b5-bbe4-fe71dedf1e28",
  "app-id": 525463029,
  "attribution-signature": "MEYCIQDTuQ1Z4Tpy9D3aEKbxLl5J5iKiTumcqZikuY/AOD2U7QIhAJAaiAv89AoquHXJffcieEQXdWHpcV8ZgbKN0EwV9/sY",
  redownload: true,
  "source-app-id": 1234567891,
  "fidelity-type": 1,
  "conversion-value": 20,
};

/** AdAttributionKit re-engagement postback signed with apple-development-identifier/1; advertised item 10738027756. */
export const AAK_APP_ID = 10738027756;
export const aakDev = {
  "jws-string":
    "eyJraWQiOiJhcHBsZS1kZXZlbG9wbWVudC1pZGVudGlmaWVyXC8xIiwiYWxnIjoiRVMyNTYifQ.eyJwb3N0YmFjay1pZGVudGlmaWVyIjoiODU1NDZFQjctRkQzOS00NEJDLTg5OTAtQzk4QTRBQzM2QTQ5IiwicHVibGlzaGVyLWl0ZW0taWRlbnRpZmllciI6MCwibWFya2V0cGxhY2UtaWRlbnRpZmllciI6ImNvbS5hcHBsZS5BcHBTdG9yZSIsImltcHJlc3Npb24tdHlwZSI6ImFwcC1pbXByZXNzaW9uIiwiYWQtbmV0d29yay1pZGVudGlmaWVyIjoiZGV2ZWxvcG1lbnQuYWRhdHRyaWJ1dGlvbmtpdCIsImRpZC13aW4iOnRydWUsInBvc3RiYWNrLXNlcXVlbmNlLWluZGV4IjowLCJjb252ZXJzaW9uLXR5cGUiOiJyZS1lbmdhZ2VtZW50Iiwic291cmNlLWlkZW50aWZpZXIiOiIxMjM0IiwiYWR2ZXJ0aXNlZC1pdGVtLWlkZW50aWZpZXIiOjEwNzM4MDI3NzU2fQ.bAdNwKd6OfHK9tofvjjua4X_JPcFTxXPQSspD9gZkinw97pY7R1aI-LSjl-oxZZF3_K2H5JK5TSEBee4_1U4oQ",
  "conversion-value": 24,
  "ad-interaction-type": "click",
  "country-code": "US",
};
