# Dashboard owner checks

Manual and unverified items of the `dashboard-simulation` design. They need a real browser, a real
device or the deployed stack, so no automated test covers them. Run them after `npx cdk deploy --all`
and record the outcome in each "Result" block.

Do not write secrets in this file: no passwords, tokens, account ids, host names, pre-signed URLs or
personal names. Describe the origin as "the deployed origin".

How to record: tick the box, then fill in date, tester, browser or device with version, and notes.
On a failure, write what you saw and open a follow-up task. Do not edit the expected result.

Outcome values: `pass`, `fail`, `not run`.

## 1. First `InitiateAuth` from the deployed origin (D16, Requirement 11)

Why: the request `Content-Type` (`application/x-amz-json-1.1`) and the CORS answer of `cognito-idp`
for the dashboard origin were not confirmed by any documentation page read during design.

Steps:
1. Open the deployed dashboard in Chrome with DevTools, Network tab.
2. Sign in with a family test account.
3. Select the `InitiateAuth` request and its preflight (`OPTIONS`).

Expected:
- [ ] The preflight succeeds and the response allows the dashboard origin.
- [ ] The `POST` returns 200 with an access token and the dashboard shows the signed-in role.
- [ ] The request `Content-Type` is `application/x-amz-json-1.1` and is accepted by Cognito.
- [ ] A wrong password shows one generic error message and no console error with credentials.

If the content type is rejected, change it to the accepted value and update D16 in `design.md`.

Result: outcome `____` · date `____` · tester `____` · browser `____`
Notes:

## 2. Real upload to the pre-signed S3 POST (Requirement 15.5)

Why: the rule that the `file` field must be the last form field comes from community reports only.
The dashboard appends it last.

Steps:
1. Sign in as a family member and open the Family page.
2. Tick the consent notice and upload one JPEG of one face (at most 5,000,000 bytes).
3. Watch the Network tab for the `POST` to the S3 pre-signed URL and then `POST /faces`.

Expected:
- [ ] The form data lists the pre-signed fields first and `file` last.
- [ ] The S3 response is a success (204) with no CORS error in the console.
- [ ] `POST /faces` returns 201 and the new member appears in the list without a face id.
- [ ] The staging object no longer exists afterwards, and the file and preview are discarded in the page.
- [ ] A photo without a face or with two faces shows the 422 message and registers nothing.

Result: outcome `____` · date `____` · tester `____` · browser `____`
Notes:

## 3. Audio unlock on iOS Safari (D10, Requirement 8.4)

Why: iOS Safari plays later audio only if the shared audio element was started inside a user gesture.

Steps (real iPhone or iPad, silent switch off, volume at a normal level):
1. Open the deployed dashboard in Safari.
2. Tap "Enter the house", then tap one scenario button, with no other tap in between.
3. Let the scenario run to the spoken line.

Expected:
- [ ] The spoken line plays with sound after the scenario button tap, without another tap.
- [ ] A second and a third scenario also play.
- [ ] If sound is blocked or off, the subtitle still shows and the page reports no error.
- [ ] The unlock itself is silent.

Result: outcome `____` · date `____` · device and iOS version `____`
Notes:

## 4. Service worker offline after one load (Requirement 19.2)

Run once in Chrome and once in Safari (desktop or iOS).

Steps:
1. Open the deployed dashboard with an empty cache and wait until the page has loaded fully.
2. Reload once so the service worker controls the page.
3. Go offline (DevTools "Offline", or airplane mode).
4. Reload and run the simulation scenarios.

Expected:
- [ ] The page loads offline, including fonts, illustrations and audio.
- [ ] Simulation mode runs a full scenario offline with sound and subtitles.
- [ ] Live cloud features show a clear offline state and API calls are not served from cache.
- [ ] Back online, a reload picks up the current `/config.json`.

Result Chrome: outcome `____` · date `____` · version `____`
Result Safari: outcome `____` · date `____` · version `____`
Notes:

## 5. Layout from 360 px to 1920 px (Requirements 18.1, 18.2)

Steps: in Chrome responsive mode, test widths 360, 480, 768, 1024, 1440 and 1920 px on the
landing, house, timeline and family views, in simulation mode with one scenario running.

Expected:
- [ ] No horizontal scroll at any width.
- [ ] At 360 px, one vertical scroll is enough to bring the subtitle into view.
- [ ] Text is readable and no control is cut off or overlapped.
- [ ] Controls are at least touch-sized at 360 px.

Result: outcome `____` · date `____` · tester `____`
Per-width notes:

## 6. Keyboard-only use and visible focus (Requirement 17.1)

Steps: unplug or ignore the mouse. Use `Tab`, `Shift+Tab`, `Enter`, `Space` and `Esc` through the
landing, a full scenario, the control panel, the timeline and the Family page (including the delete dialog).

Expected:
- [ ] Every control is reachable and usable by keyboard.
- [ ] A visible focus ring shows on every focused element, on light and dark areas.
- [ ] The tab order follows the visual order and no keyboard trap exists.
- [ ] Dialogs move focus in, return it on close and close with `Esc`.

Result: outcome `____` · date `____` · tester `____` · browser `____`
Notes:

## 7. Screen reader pass over one scenario (Requirement 17.5)

Steps: use VoiceOver (macOS or iOS) or NVDA. Run one family scenario and one stranger scenario.

Expected:
- [ ] Each state change and each subtitle line is announced once, in order, without repeats.
- [ ] Controls have meaningful names and the camera and microphone indicator is announced.
- [ ] Decorative illustration is skipped or described briefly.
- [ ] Errors are announced.

Result: outcome `____` · date `____` · reader and version `____`
Notes:

## 8. No flashing and no sudden loud sound (Requirement 17.8)

Steps: watch the lantern fade, the state transitions and the stranger scenario. Listen to every
cached voice line and effect at a normal volume, with headphones off and then on.

Expected:
- [ ] Nothing flashes or changes brightness more than 3 times per second in any scenario, with and without reduced motion.
- [ ] No sound starts abruptly or is much louder than the other lines.
- [ ] The stranger whisper stays family-friendly in volume.

Result: outcome `____` · date `____` · tester `____`
Notes:

## 9. X1 and X2 confirmed in the deployed stack (Requirements 11.1, 15.5)

X1: `ApiStack` public app client allows `ALLOW_USER_PASSWORD_AUTH`, has no client secret, and the user
pool has no Cognito domain.

X2: the data bucket CORS rule for browser uploads. Note: X2 was implemented in `WebStack` through a
custom resource, not in `DataStack` as the design first planned. Check it on the deployed bucket.

Steps (use the AWS CLI or console on the deployed stack, and do not paste account ids into this file):
1. Read the app client settings, for example `aws cognito-idp describe-user-pool-client`.
2. Read the data bucket CORS, for example `aws s3api get-bucket-cors`.

Expected:
- [ ] X1: `ExplicitAuthFlows` contains `ALLOW_USER_PASSWORD_AUTH` and no client secret exists.
- [ ] X1: the user pool has no domain.
- [ ] X2: one CORS rule has `AllowedMethods` `POST`, `AllowedHeaders` `*`, and `AllowedOrigins` exactly the CloudFront origin of the dashboard.
- [ ] X2: `AllowedOrigins` does not contain `*`.
- [ ] X2: the rule survives a second `npx cdk deploy --all` (the rule is still present and unchanged).
- [ ] The Family page upload in check 2 works, which proves X2 end to end.

Result X1: outcome `____` · date `____`
Result X2: outcome `____` · date `____`
Notes:

## Sign-off

- [ ] All sections above are `pass`, or each failure has a follow-up task.
- Date `____` · Owner `____`
