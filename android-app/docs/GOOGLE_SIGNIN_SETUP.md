# Android Google Sign-In — exact configuration guide

The app implements **native Android Google sign-in** end-to-end in code:

```
Google button (in-app sheet)
  → DsmnruAppPlugin.googleSignIn()      (Java, Credential Manager)
      → device Google account chooser   (no browser, no Chrome, no popup)
  → Google ID token (audience = the project's Web client ID)
  → auth.signInWithGoogleCredential()   (www/js/auth.js)
      → POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp
        (the same call the Firebase JS SDK makes — SAME dsmnru-data project,
         SAME user identity as the website)
  → in-app session restored exactly like email/password sign-in
  → existing users/{uid} profile sync (one owner-scoped check)
```

There is **no second Firebase project, no second user database and no website
hand-off** anywhere in this flow. What the code cannot do by itself is the
Google-side *registration* of this app — those steps live in the Firebase /
Google Cloud consoles and are listed below. Until they are done, the plugin
reports `GOOGLE_SIGNIN_NOT_CONFIGURED` and the app explains it in-app while
offering email/password sign-in (never a redirect).

---

## 1. What is already in the repository

| Piece | Where |
|---|---|
| Credential Manager flow (Java) | `android/app/src/main/java/com/dsmnru/pyq/DsmnruAppPlugin.java` → `googleSignIn()` |
| Token exchange + session handling (JS) | `android-app/www/js/auth.js` → `signInWithGoogleCredential()` |
| UI (button, explainer sheets, fallbacks) | `android-app/www/js/authui.js` |
| Library dependencies | `android-app/android/app/build.gradle` → `androidx.credentials:credentials:1.3.0`, `credentials-play-services-auth:1.3.0`, `com.google.android.libraries.identity.googleid:googleid:1.1.1` |
| Client-ID placeholder (public value, **not** a secret) | `android/app/src/main/res/values/strings.xml` → `google_web_client_id` |

## 2. What must be configured outside the repository (one time)

### a. Set the OAuth **Web client ID**

1. Open the **Firebase console → Project `dsmnru-data` → Authentication →
   Sign-in method → Google**. If Google is not enabled yet, enable it (this
   is also what the website's Google button uses).
2. Copy the **Web client ID** shown there (it ends in
   `.apps.googleusercontent.com`). It is the `client_type: 3` entry of the
   project's `google-services.json` / the client ID on the Google provider.
   Alternatively: Google Cloud console → APIs & Services → Credentials →
   the *OAuth 2.0 Client ID* of type **Web application** belonging to
   `dsmnru-data`.
3. Paste it into
   `android-app/android/app/src/main/res/values/strings.xml`:

   ```xml
   <string name="google_web_client_id" translatable="false">1234567890-abcdefg.apps.googleusercontent.com</string>
   ```

   (Or override it at build time with a `resValue` in `build.gradle` — any
   mechanism that sets the `google_web_client_id` string resource works.
   This ID is a public identifier; committing it is safe and intended.)

### b. Register the app's Android OAuth client (package + SHA-1)

Google verifies that the calling app (package name + signing-certificate
SHA-1) belongs to the same project:

1. Get the SHA-1 of the keystore that will sign the APK:

       keytool -list -v -keystore <keystore>.jks -alias <alias>            # release
       keytool -list -v -keystore ~/.android/debug.keystore \
               -alias androiddebugkey -storepass android                   # debug builds

2. Register **both** fingerprints you build with:
   - *Easiest path:* Firebase console → Project settings → **Your apps →
     Android app `com.dsmnru.pyq` → Add fingerprint** (add debug **and**
     release SHA-1). Firebase creates the Android OAuth client automatically.
   - *Or manually:* Google Cloud console → APIs & Services → Credentials →
     **Create credentials → OAuth client ID → Android** — package name
     `com.dsmnru.pyq`, paste each SHA-1.
3. Google sign-in on a device checks the running APK's signature against
   these fingerprints — a debug APK needs the **debug keystore fingerprint**
   registered, a release APK the release one.

### c. Nothing else

- No `google-services.json` is required for sign-in (the app talks to
  Identity Toolkit REST with the project's public web API key, exactly like
  the website). If you add `google-services.json` later for FCM, the build
  already auto-applies the Google Services plugin.
- No OAuth client secret, no keystore, no service-account JSON may ever be
  committed — none is needed by this flow.

## 3. Verify

1. `npm ci && npx cap sync android && cd android && ./gradlew assembleDebug`
2. Install the APK on a device **with a Google account and Play services**.
3. Profile tab (signed out) → **Sign in with Google** → the device account
   chooser appears → pick an account → the app is signed in and Profile
   shows "Google account". If the same email is used on the website, it is
   the *same* Firebase user.
4. If the chooser reports an error instead, the usual causes are (a) the
   Web client ID in `strings.xml` doesn't belong to `dsmnru-data`, or (b)
   the SHA-1 of the installed APK isn't registered (step b).

## 4. Behaviour matrix (implemented)

| Situation | App behaviour |
|---|---|
| Configured + Google account on device | Native account chooser → Firebase session |
| User closes the chooser | Silent return, nothing changes |
| Build missing the client ID (`REPLACE_WITH…` placeholder) | In-app explainer + email/password sign-in (never a website redirect) |
| Device without Play services / no Google account | In-app explainer + email/password sign-in |
| Any unexpected Credential Manager error | Typed error surfaced as a toast, email/password offered |
