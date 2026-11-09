# Privacy Policy

**Application:** VRCX ([minecartchris fork](https://github.com/minecartchris/VRCX)), avtr.zip integration
**Last updated:** 9 November 2026

## Summary

VRCX is a desktop application that runs entirely on your own computer. There is
no server operated by this application's developer, no account to create with
us, and no analytics. Nothing you do in the app is reported to the developer.

When you connect the app to avtr.zip, it talks to avtr.zip directly from your
machine, and everything it stores — including your access tokens — stays in
VRCX's local settings file on that machine.

## What this policy covers

This policy covers the avtr.zip integration in this fork of VRCX: the avatar
search, feature filters, recommendations and likes found under
**Plugins → Avatars**, and the OAuth connection that powers them.

It does not cover avtr.zip itself, VRChat, or GitHub. Those are run by other
people under their own policies, linked below.

## What the app stores on your computer

When you connect to avtr.zip, the following is written to VRCX's settings
database at `%APPDATA%\VRCX\VRCX.sqlite3`:

| What | Why |
| --- | --- |
| Access token (`avto_…`) | Authenticates each request to avtr.zip. Valid for one hour. |
| Refresh token (`avtf_…`) | Keeps you connected without re-approving. Replaced each time it is used. |
| Token expiry time and granted scopes | So the app knows when to refresh, and which features you permitted. |
| Your avtr.zip client id, and client secret if you set one | Identifies the app to avtr.zip. |
| Cached account details | Your avtr.zip account id, your Discord display name, and your linked VRChat user id and display name, so the app can show which account is connected. |

This file is **not encrypted**, which is how VRCX has always stored its
settings. Anyone with access to your user profile on that computer, or to a
backup of it, can read these values. Treat the file as you would a saved
password.

None of it is transmitted anywhere except back to avtr.zip, as the
authorization header on requests you cause the app to make.

## What the app sends to avtr.zip

Only in response to something you do in the app:

- **Searching:** your search text and any filters you selected.
- **Search by image:** the image file you choose. avtr.zip's developer
  documentation states the upload is used once and then discarded.
- **Browsing:** requests for a specific avatar, visually similar avatars, an
  avatar matching a thumbnail, the tag and feature lists, and author pages.
- **Likes:** a like or unlike request for a specific avatar, and requests to
  read the avatars you have liked.
- **Recommendations:** a request for the avatars avtr.zip suggests for you.
- **Identity:** a single request asking which account your connection belongs
  to, used to show the account name in the app.

Every one of those carries your access token, so avtr.zip can tell they came
from your account. As with any request to a website, avtr.zip can also see your
IP address and the time of the request. Avatar thumbnails and renders are loaded
from avtr.zip's servers when results are shown, so displaying results contacts
them too, and your browser engine may cache those images locally.

What avtr.zip does with any of this is governed by
[avtr.zip's own privacy policy and developer terms](https://avtr.zip/developers/terms).

## Permissions the app asks for

avtr.zip shows you these on its approval screen, and you can decline any time
by not approving:

- `search` — search avatars and authors.
- `search:image` — search avatars by image.
- `identify` — read which avtr.zip account you are, including your Discord name
  and linked VRChat account.
- `likes:read` — read the avatars you have liked, and your recommendations.
- `likes:write` — like and unlike avatars on your behalf.

The `likes` permissions act as your linked VRChat identity on avtr.zip: the
likes read and written are the same ones you see when signed in there.

## What the app does not do

- It does not send your activity, searches, tokens or account details to the
  developer of this fork. There is no server to send them to.
- It does not include analytics, advertising, tracking or fingerprinting.
- It does not sell, rent or share your information with anyone.
- It does not read your avtr.zip data unless you connected the app and granted
  the matching permission.

## Crash reporting

Nightly builds can send crash reports to the upstream VRCX project's error
reporting service. This is **off by default and must be switched on by you**,
and the code is not included in stable builds at all. When enabled, a report
contains the error and a randomly generated installation id. It goes to the
upstream VRCX project, not to this fork's developer.

Stable releases send no crash reports.

## VRChat

VRCX's other features sign in to VRChat with your VRChat credentials and store
data about your friends, worlds and avatars locally. That behaviour comes from
upstream VRCX, predates this integration, and is subject to
[VRChat's privacy policy](https://hello.vrchat.com/legal/privacy).

## Your choices

- **Disconnect.** In **Plugins → Avatars**, Disconnect tells avtr.zip to revoke
  your tokens — which ends every token issued on that connection — and deletes
  the stored tokens and cached account details from your computer.
- **Revoke from avtr.zip.** You can remove this app from your avtr.zip account
  page at any time, with or without using the app. The app's access stops
  working immediately.
- **Delete everything stored locally.** Close VRCX and delete
  `%APPDATA%\VRCX\VRCX.sqlite3`. This removes the tokens along with the rest of
  your VRCX settings.
- **Ask avtr.zip.** For data held on avtr.zip's side — your likes, your
  account, their logs — contact avtr.zip; this app's developer has no access to
  it and cannot act on it for you.

## Children

VRChat requires its users to be 13 or older. This application is not directed
at children under 13, and collects nothing from anyone.

## Changes to this policy

Any change will be published at this address, with the date at the top updated.
If a change means the app starts handling your data in a way this policy does
not already describe, it will be noted in the release that introduces it.

## Contact

Questions about this policy or the application:
[open an issue](https://github.com/minecartchris/VRCX/issues) on the project's
GitHub repository.
