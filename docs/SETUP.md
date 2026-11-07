# Connecting your accounts

Relay talks to Gmail and Outlook directly from your PC using **your own** OAuth app
registrations. Nothing goes through a Relay server (there isn't one). You need to
create two app registrations once, then paste three values into
**Relay → Settings → Connections**:

| Value | Where it comes from |
| --- | --- |
| Google OAuth client ID | Google Cloud Console (Part 1) |
| Google OAuth client secret | Google Cloud Console (Part 1) |
| Microsoft application (client) ID | Microsoft Entra admin center (Part 2) |

Expect about 10 minutes for each part.

---

## Part 1: Google (all Gmail / Google Workspace accounts)

1. Go to <https://console.cloud.google.com/> and sign in with any Google account
   (your personal one is fine). Create a new project named **Relay**.
2. **Enable the Gmail API**: *APIs & Services → Library*, search "Gmail API", click **Enable**.
3. **Configure the consent screen**: *Google Auth Platform → Branding* (older UI:
   *OAuth consent screen*) → **Get started**.
   - App name: `Relay`, support email: your email.
   - Audience: **External**.
   - Contact email: your email → **Create**.
4. **Add the Gmail scope**: *Data access → Add or remove scopes*, add
   `https://www.googleapis.com/auth/gmail.modify` → **Update → Save**.
5. **Add yourself as a test user**: *Audience → Test users → Add users*, and add
   **every Gmail address** you want in Relay (personal and work).
6. **Create the client**: *Clients → Create client* → Application type **Desktop app**,
   name `Relay` → **Create**. Copy the **Client ID** and **Client secret** into Relay's Settings.

### Things to know (Google)

- **Weekly re-sign-in in "Testing" mode.** While the app's publishing status is
  *Testing*, Google expires refresh tokens after 7 days, so Relay will ask you to
  sign in again weekly. To stop that, go to *Audience* and click **Publish app**
  (status becomes *In production*). You don't need Google's verification for
  personal use. You'll just see a "Google hasn't verified this app" screen when
  signing in. Click **Advanced → Go to Relay**.
- **Work Gmail (Google Workspace).** Your company admin may block unverified
  third-party apps. If sign-in says the app is blocked, ask IT to allow it, or
  create the OAuth client inside the company's own Google Cloud org with
  Audience = **Internal**.
- Relay requests `gmail.modify`: read mail, change labels (read/star/archive),
  move to trash, and send. It cannot permanently delete mail.

---

## Part 2: Microsoft (Outlook.com, work, and school accounts)

One registration covers all Microsoft account types.

1. Go to <https://entra.microsoft.com/> → *Identity → Applications → App registrations*
   → **New registration**.
   - You need an account that can create app registrations. A personal
     Outlook.com account alone usually can't. Sign up for a free Azure account at
     <https://azure.microsoft.com/free> (it creates a directory for you), or use a
     work tenant where you're allowed to register apps.
2. Fill in:
   - Name: `Relay`
   - Supported account types: **Accounts in any organizational directory (Any
     Microsoft Entra ID tenant – Multitenant) and personal Microsoft accounts**
   - Redirect URI: platform **Public client/native (mobile & desktop)**, value `http://localhost`
3. Click **Register**, then copy the **Application (client) ID** into Relay's Settings.
4. *API permissions → Add a permission → Microsoft Graph → Delegated*, add:
   `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access`. (Optional. Relay
   asks for these at sign-in anyway, but listing them makes the consent screen clearer.)
5. No client secret is needed. Relay is a public client and uses PKCE.

### Things to know (Microsoft)

- **School and work accounts may need IT approval.** Many organizations only
  let users approve apps from verified publishers, especially for mail access.
  If you see **"Need admin approval"** (error `AADSTS65001` or `AADSTS90094`),
  your IT department has to grant consent for Relay in their tenant. They can
  do it from the link on that screen. Personal Outlook.com accounts aren't affected.
- Relay signs in through `login.microsoftonline.com/common`, so the same client
  ID works for every tenant.

---

## Adding accounts

1. Run Relay (`npm run app`), open **Settings**, paste the values, and click **Save**.
2. Click **+ Gmail** or **+ Microsoft** in the sidebar. Your browser opens. Pick the
   account, approve, and return to Relay. The first sync starts immediately.
3. Repeat for each account. Relay guesses a group (Personal, Work, or School) from the
   domain, and you can change it in Settings.

## Where Relay keeps data

| What | Where |
| --- | --- |
| Settings (client IDs) | `%APPDATA%\com.relay.mail\config.json` |
| Mail cache + accounts | `%APPDATA%\com.relay.mail\relay.db` (SQLite) |
| Refresh tokens | Inside `relay.db`, encrypted with Windows DPAPI (only your Windows user can decrypt them) |

Removing an account in Settings deletes its local cache and token. To fully
revoke access, also remove Relay at <https://myaccount.google.com/permissions>
or <https://account.microsoft.com/privacy/app-access>.

For development you can also set `RELAY_GOOGLE_CLIENT_ID`,
`RELAY_GOOGLE_CLIENT_SECRET` and `RELAY_MICROSOFT_CLIENT_ID` environment
variables instead of using the Settings screen.
