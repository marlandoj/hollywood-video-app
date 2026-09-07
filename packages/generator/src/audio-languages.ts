/** Base-language codes documented for the pinned Sonic 3.6 snapshot. */
export const AUDIO_LANGUAGES = ["en","de","es","fr","ja","pt","zh","hi","ko","it","nl","pl","ru","sv","tr","tl","bg","ro","ar","cs","el","fi","hr","ms","sk","da","ta","uk","hu","no","vi","bn","th","he","ka","id","te","gu","kn","ml","mr","pa","or","ur"] as const;
export type AudioLanguage = typeof AUDIO_LANGUAGES[number];
export function audioLanguage(value:unknown):AudioLanguage {
  if(typeof value!=="string"||!AUDIO_LANGUAGES.includes(value as AudioLanguage))throw new Error("Choose a supported dialogue language.");
  return value as AudioLanguage;
}
