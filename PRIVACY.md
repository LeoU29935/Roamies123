# Privacy

Effective date: 10 November 2026

Roamies is an open-source desktop app made by an individual developer. This page says, in plain words, what
data Roamies handles and where it goes.

## The short version

- The developer runs no servers and collects nothing from you.
- There is no analytics or telemetry.
- Data leaves your computer only to services you choose to use, listed below.

## What leaves your computer, and where it goes

**The AI provider you sign in to** (Anthropic via Claude Code, OpenAI/ChatGPT, or a provider you add with an API
key) receives:

- your messages and the conversation so far
- a "live state" block: the date and time, your time zone, the name or title of the app and window in front,
  and the facts and commitments Roamies has saved in memory
- screenshots or window text, when Roamies looks at your screen to answer

**Fish Audio** or **Google** (Gemini), whichever you pick as the voice, receives the text of each reply to speak it, only if spoken replies are on. It uses your own key for that service (for Gemini, the Gemini key you added for the AI is used unless you save a separate one for the voice).

**GitHub** is used to check for and download updates.

**Hugging Face** is used once, on Windows and Linux, to download the speech model.

**Wikipedia** is used to fetch photos for photo cards, and websites' `favicon.ico` is fetched for source cards.

**Websites** that you or the agent open or fetch (for example with its `web_fetch` tool) receive the usual
request a browser would send.

**Search engines**: when the agent searches the web (its `web_search` tool) on a model from Anthropic, Anthropic
runs the search. On other providers, or when that search fails, the search words go to DuckDuckGo and, if it
doesn't answer, to Brave, Bing or Google.

Each provider's own privacy policy applies to what is sent to it.

## Speech, microphone and screen

- **macOS:** speech is turned into text on your Mac by Apple's on-device recognizer. On Macs where on-device
  recognition isn't available, Apple's recognizer may use Apple's servers, under Apple's terms.
- **Windows and Linux:** speech is turned into text on your computer (Parakeet).
- The microphone is used only while you hold the talk keys (or, on Linux with Wayland, from your talk shortcut
  until you press it again or pause).
- **Wake word (macOS, off by default):** when you turn it on, the microphone stays open so Roamies can hear
  "Hey Roamies", and macOS shows its microphone dot the whole time. That audio is turned into text only on your Mac
  (it never starts on a Mac that would need Apple's servers). Nothing is kept or sent anywhere until you say the phrase;
  the log notes only when it heard speech and how close that came to the phrase, never what was said.
- **Memory sync (off by default):** if you choose a sync folder, Roamies writes your reminders, commitments and
  remembered facts to `Roamies Sync/<random id>.json` in it, so your other computer can read them. Everything in that
  folder is encrypted (AES-256-GCM) with a key made from a passphrase you type on each computer; the key is kept in
  your Keychain (macOS), with DPAPI (Windows) or in your keyring (Linux), and the passphrase itself isn't stored. Your
  sync service sees only encrypted files and random file names. Conversations, sign-ins and keys are never written
  there. Stop syncing in the panel to remove the key from this computer; the folder copy stays until you delete it.
- **Clap to wake (macOS, off by default):** the same open microphone, listening for two claps. The clap check only
  measures how loud the sound is from moment to moment, on your Mac; nothing is kept or sent until you clap twice, and
  the log notes only that it heard two claps.
- The screen is captured only when Roamies answers something about your screen, or when you mark an area. On Linux
  with Wayland it's taken through your desktop's screenshot portal; the copy the portal saves is deleted right away.

## What's stored on your computer

Everything lives in `~/.gg` (on Windows, `%USERPROFILE%\.gg`) and stays on your computer:

| File or folder           | What's in it                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `sidekick.json`          | your settings                                                                       |
| `sidekick/memory.json`   | facts Roamies learned and your commitments                                          |
| `sidekick/sessions/`     | conversations (the newest 60 are kept)                                              |
| `sidekick/logs/`         | activity logs: tool names, timings, errors and short snippets of tool results (such as a line of window or page text); text you type into apps or files is reduced to its length; kept 7 days |
| `sidekick/usage.jsonl`   | token counts and timings only, never content                                       |
| `auth.json`              | your AI sign-ins, shared with GG Coder                                              |

**Save Diagnostics** (the panel's About page, or the tray icon's menu) writes one `roamies-diagnostics-….log` file to
your Downloads folder, only when you ask. It holds the logs above, your system and screen details, your microphones and
permission states, and your settings. Keys, tokens, email addresses, names, your home folder and user name are removed
first. Nothing is uploaded: it stays on your computer unless you choose to send it (for example by attaching it to a
GitHub issue).

Your Fish Audio key and your Gemini voice key are kept in the macOS Keychain, encrypted with DPAPI on Windows, or in your desktop's keyring
(through the Secret Service) on Linux.

You can see what Roamies remembers on the panel's **Memory** page, and remove it with **Forget** or
**Forget Everything**.

## Deleting everything

Follow the [Uninstall](README.md#uninstall) steps in the README.

## Children

Roamies isn't made for children under 13 (or the minimum age in their country), and it doesn't ask about age.
Parents should supervise any use by children.

## Changes

Changes to this notice are made in this file on GitHub, so its history shows what changed and when.

## Questions

Email [ken@kenkais.com](mailto:ken@kenkais.com) or [open an issue](https://github.com/KenKaiii/Roamies/issues).
