/**
 * Every fixed UI string of the dashboard, in one place (Requirement 18.5).
 *
 * The English wording is copied from `.kiro/specs/dashboard-simulation/requirements.md`. UI copy
 * is English with Japanese accents; `copy.ja.ts` holds the Japanese translation that the header's
 * language switch selects. The doll's spoken lines live in the voice catalog, not here.
 *
 * `COPY` is a live ES module binding to the current language, so components keep importing it and
 * read the right text on their next render. `setLanguage` is the only writer; the App shell calls
 * it and then re-renders. Text is always read at render time, never cached at module load.
 */
import { INDICATOR_TEXT } from "../simulation/indicator";
import { JA } from "./copy.ja";

export const EN = {
  landing: {
    titleKanji: "座敷童子",
    titleReading: "Zashiki-warashi",
    titleTranslation: "The child spirit of the house",
    // Exactly two sentences (Requirement 1.1).
    legend:
      "In old Iwate farmhouses, a child spirit called the zashiki-warashi is said to guard the house and bring it good fortune. " +
      "This doll wakes when someone draws near, lights her lantern, and turns slowly to see who has come.",
    enter: "Try the web simulation",
    signIn: "Sign in",
    configUnavailable: "Cloud features are unavailable right now",
  },

  scenarios: {
    family_home: "A family member comes home",
    stranger_night: "A stranger enters at night",
    nobody_there: "Something moves, but no one is there",
    network_down: "The network is down",
    stop: "Stop",
  },

  verdicts: {
    family: "Family",
    stranger: "Stranger",
    no_face: "No face",
    uncertain: "Uncertain",
    offline: "Offline",
  },

  house: {
    heading: "Web simulation",
    intro:
      "This screen is for people who do not have the real doll at hand. A virtual doll in your browser reacts the same way the real one does. Press a button on the right to call a visitor.",
    scenariosHeading: "Call a visitor",
    stateLabel: "State",
    verdictLabel: "Verdict",
    noVerdict: "No verdict yet",
    states: {
      sleeping: "Waiting quietly",
      waking: "Waking",
      seeking: "Looking for someone",
      gazing: "Gazing",
      greeting: "Greeting",
      warning: "Warning",
      uncertain: "Unsure",
      conversing: "Talking",
      cooldown: "Settling down",
      remote: "Under remote control",
    },
  },

  realDollPage: {
    intro:
      "This is the control room for the real doll: the one running on a Raspberry Pi in someone's home. Check how she is, and move her, from here.",
    signInNeeded: "Sign in as family (top right) to see and control the real doll.",
    needFamily: "Only the family can control the real doll. You can still watch her state here.",
  },
  tips: {
    simulation:
      "A virtual doll in your browser. You can try how the doll reacts to visitors without owning the real one. It never uses your real camera or microphone.",
    realDoll: "The state and controls of the real doll in someone's home. Available when you sign in as family.",
    diary: "A diary of the visits the doll saw, each with a short note in the doll's own words.",
    simulatedDiary: "Visits you tried in the web simulation. They disappear when you close this page.",
    realDiary: "Visits the real doll met. Visible when you sign in as family.",
    residents:
      "Register faces so the doll can tell the people of the house apart from strangers. Registration needs the person's consent, and a face can be deleted at any time.",
    verdict: "What the doll decided: family, stranger, no face, unsure, or offline.",
    state: "What the doll is doing now: waiting, waking, looking, gazing and so on.",
  },
  diary: {
    // The doll's own notes about a visit. Same count per kind in every language.
    comments: {
      family: ["Someone from the house came home. I said welcome back.", "The people I love were back. I felt calm."],
      stranger: ["A stranger was here. I was scared.", "Someone I did not know stood close by. I kept watching."],
      strangerNotified: [
        "A stranger was here. I was scared, so I told everyone.",
        "I did not know that person. I warned the house.",
      ],
      no_face: ["I think someone was there, but I could not see a face.", "A shadow passed by. No face at all."],
      uncertain: ["I could not tell who it was. I felt a little uneasy.", "I looked and looked, and still was not sure."],
      offline: ["I could not reach outside, so I decided by myself.", "It was quiet out there. I did what I could alone."],
      unknown: ["I was drowsy and do not remember much.", "I was half asleep. It is all a blur."],
    },
  },
  timeline: {
    pageTitle: "Today's diary",
    simulatedHeading: "WEB simulation visits",
    realHeading: "Real doll visits",
    columns: { time: "Time (Japan time)", verdict: "Verdict", diary: "Diary", notes: "Notes" },
    familyNotified: "Family notified",
    // Visible note so the label never claims a real notification (design D13).
    familyNotifiedNote: "(simulated, nothing was sent)",
    liveCloudLabel: "Extra features",
    showOlder: "Show older",
    snapshotExpired: "Snapshot expired",
    empty: "No visits yet",
    loadFailed: "The doll's story could not be loaded",
    tryAgain: "Try again",
    hiddenFromGuests: "The owner has hidden real visits from guests. Try the scenarios instead.",
  },

  roles: {
    visitor: "Guest",
    reviewer: "Reviewer",
    family: "Family",
    signedOutAgain: "Please sign in again",
    forbidden: "This is someone's home. That area is closed to guests.",
    signOut: "Sign out",
  },

  live: {
    heading: "Extra features",
    switchLabel: "Use the extra features",
    abilitiesIntro: "What you can do with them:",
    abilities: [
      "Check faces with the real cloud (face search) instead of the bundled samples.",
      "Have the doll's voice made by real speech synthesis, and ask for a brand-new line.",
      "It runs the same visits the real doll would get. The real doll does not move.",
    ],
    tip: "Signed-in users only. The scenarios above run through the real cloud instead of the samples in your browser. It uses the cloud, so it is limited to a few runs per hour.",
    generateLabel: "Generate a new line",
    networkDown: "No cloud call: the network is down",
    rateLimited: (seconds: number): string => `The cloud needs a rest. Try again in ${seconds} seconds.`,
    noAnswer: "The cloud did not answer",
    runInSimulation: "Run in Simulation mode",
    measuredInBrowser: "Durations measured in the browser",
  },

  device: {
    connected: "Connected to the doll",
    outOfReach: "The doll is out of reach (no recent report)",
    neverSeen: "never seen",
    motionOff: "Motion is switched off on the doll",
    activity: "What she is doing",
    mode: "Mode",
    modeGuard: "Guarding (wakes when someone comes near)",
    modeSleep: "Not guarding (ignores visitors)",
    modeRemote: "Remote control (ignores visitors)",
    loadFailed: "The latest status could not be loaded. Showing the last one that arrived.",
    loadFailedNothing: "The status could not be loaded. Try again in a moment.",
    head: "Head (left/right / up/down)",
    left: "left",
    right: "right",
    up: "up",
    down: "down",
    center: "straight",
    lantern: "Lantern brightness",
    lanternOff: "off",
    lastSeen: "Last report",
  },

  privacy: {
    simulation: INDICATOR_TEXT.simulation,
    unknown: INDICATOR_TEXT.unknown,
    off: INDICATOR_TEXT.off,
    cameraOn: INDICATOR_TEXT.cameraOn,
    microphoneOn: INDICATOR_TEXT.microphoneOn,
  },

  controls: {
    lookLeft: "Look left",
    lookRight: "Look right",
    line: "Line",
    linePlaceholder: "Choose a line…",
    lineSay: "Say this line",
    lanternLevel: "Lantern brightness",
    fadeLabel: "Seconds until it reaches that brightness",
    lanternSet: "Change the lantern brightness",
    sleep: "Pause guarding",
    wake: "Set back to guard mode",
    remoteStart: "Start remote control",
    restingHint:
      "The doll is waiting quietly, so she cannot move her head or change the lantern. Press “Start remote control” to wake her and move her yourself.",
    remoteHint:
      "Under remote control. She goes back to guarding after two minutes without a command, or when you press “Set back to guard mode”.",
    sent: "Sent to the doll. Waiting for her answer…",
    accepted: "The doll accepted it.",
    offline: "The doll is offline. The command was not stored and will not play later.",
    tryAgain: "Try again",
    sendFailed: "The command could not be sent. ",
    lockedControls: "This is someone's home. Only the family can call the doll.",
  },

  remote: {
    heading: "Remote actions",
    photoHeading: "Take a photo",
    photoTip:
      "The doll wakes, lights her lantern, takes one picture and goes back to waiting. If she is already awake with a visitor, she takes the picture at once. Only the family can see it, and it is deleted after a few days. The camera indicator at the top shows while she is looking.",
    photoNote: "This uses the real camera for a moment.",
    photoButton: "Take a photo",
    photoWaiting: "Waiting for the photo…",
    photoReady: "Here is the photo.",
    photoAlt: "The photo the doll just took",
    photoTimeout: "No photo arrived. The doll may be out of reach. Try again.",
    photoFailed: "The request could not be sent. Try again.",
    sayHeading: "Make the doll speak",
    sayTip:
      "Type a Japanese line and the doll says it aloud, even when she is waiting quietly. The cloud checks the text first: up to 60 characters, no Latin letters, no emoji and no frightening words.",
    sayLabel: "What should the doll say? (Japanese, up to 60 characters)",
    sayWarning:
      "She speaks out loud to whoever is near her, a guest or a stranger too. Do not type names or private details.",
    sayButton: "Say it",
    saySent: "Sent. The doll is saying it.",
    sayInvalid:
      "That text cannot be spoken. Use Japanese only, up to 60 characters, with no Latin letters, emoji or frightening words.",
    sayFailed: "The message could not be sent. Try again.",
    offline: "The doll is offline. The request was not stored and will not play later.",
    limited: (seconds: number): string => `Too many requests. Try again in ${seconds} seconds.`,
  },

  refusal: {
    state:
      "The doll did not do it: she is waiting quietly or busy right now (for example finishing a visit or talking). Try again in a moment.",
    speakRejected: "The doll did not say it: that line does not fit what is happening right now.",
    audioBusy: "The doll did not say it: she is still speaking.",
    unknownLine: "The doll did not say it: she does not know that line.",
    other: (code: string): string => `The doll did not do it (${code}).`,
  },

  family: {
    lockedFaces: "This is someone's home. Only the family can manage faces.",
    register: "Register",
    delete: "Delete",
    oneFace: "The photo must show exactly one face.",
    storedNote: "Faces are stored only in your AWS account and can be deleted at any time.",
    heading: "The people of the house",
    pageTitle: "Residents",
    columns: { name: "Name", photos: "Photos", added: "Added", actions: "Action" },
    noMembers: "No faces registered yet",
    loadFailed: "The list of faces could not be loaded",
    noticeOutOfDate: "This consent notice is out of date. Reload the page.",
    consentLabel: "The person in the photo agrees to this use",
    nameLabel: "Display name (1 to 40 characters)",
    photoLabel: "Photo (JPEG or PNG, up to 5 MB)",
    addToLabel: "Add to",
    newMember: "New member",
    previewAlt: "Selected photo preview",
    consentAgain: "The consent notice changed. Please read it and confirm again.",
    registered: "Face registered",
    registerFailed: "The face could not be registered. Try again.",
    deleteFailed: "The face could not be deleted. Try again.",
    deleteTitle: (name: string): string => `Delete ${name}?`,
    deleteBody: "Their face vectors and member record will be removed.",
    confirmDelete: "Delete",
    cancel: "Cancel",
  },

  talk: {
    heading: "Talk to the doll",
    notice: "Your voice is sent to Amazon Bedrock in Tokyo to make the doll answer. It is not stored.",
    talk: "Talk",
    talkReal: "Talk through the real doll",
    stop: "Stop",
    starting: "Connecting… Wait until “Microphone on” appears.",
    speakNow: "Now. Speak to the doll in Japanese. She waits until you say something.",
    speakNowReal: "Now. Speak to the doll herself, within about 1 meter. She waits until you say something.",
    ending: "Ending the conversation…",
    micOn: "Microphone on",
    watching: "The real doll is listening. This page only shows the subtitles.",
    subtitlesLabel: "Subtitles",
    you: "You",
    doll: "Doll",
    remainingToday: (n: number): string => `${n} conversation${n === 1 ? "" : "s"} left today`,
    tryAgain: "Try again",
    disabled: {
      visitor: "Sign in to talk to the doll.",
      unknown: "Talking is not available right now.",
      off: "Talking is switched off right now.",
      noRole: "Your account cannot start a conversation.",
      none: "Today's talking time is used up. Try again tomorrow.",
      offline: "Offline: talking needs a connection.",
    },
    errors: {
      rate_limited: "Today's talking time is used up. Try again tomorrow.",
      session_active: "The doll is already in a conversation.",
      voice_unavailable: "Talking is switched off right now.",
      forbidden: "Your account cannot start a conversation.",
      unauthorized: "Please sign in again.",
      microphone: "The microphone could not be used. Check the browser permission and try again.",
      connection: "The voice connection failed. Try again.",
      other: "The conversation could not be started. Try again.",
    },
    ended: {
      silence: "The conversation ended after a quiet moment.",
      limit: "The conversation reached its time limit.",
      stranger: "The conversation ended because the doll saw someone she does not know.",
      user: "You ended the conversation.",
      manual: "The conversation was ended manually.",
      language: "The conversation ended: the doll only speaks Japanese.",
      unsafe_output: "The conversation ended to keep things friendly.",
      error: "The conversation ended because of an error.",
      no_client: "The conversation ended: no one was listening.",
      offline: "The conversation ended because the doll went offline.",
    },
  },

  locked: {
    visitor: "Sign in to see the real doll.",
  },

  signIn: {
    heading: "Sign in",
    username: "Username",
    password: "Password",
    submit: "Sign in",
    cancel: "Cancel",
    working: "Signing in…",
    failed: "Sign-in failed. Check your username and password.",
    needsSetup: "This account needs setup. Ask the owner.",
    offline: "The sign-in service cannot be reached. Check your connection.",
    checking: "Checking sign-in…",
    signedInAs: "Signed in as",
  },

  shell: {
    infoLabel: "What is this?",
    skipToContent: "Skip to content",
    nav: { landing: "Home", house: "Web simulation", doll: "Remote control", timeline: "Today's diary", family: "Residents", help: "Help" },
    mute: "Mute sound",
    unmute: "Sound on",
    soundOn: "Sound: on",
    soundMuted: "Sound: muted",
    realDollHeading: "Remote control",
    offlineBanner: "Offline: the simulation still works",
    offlineLive: "Offline: the extra features need a connection.",
    offlineFaces: "Offline: face changes need a connection.",
    errorBoundary: "The doll lost her thread. Reload to start again.",
    languageToggle: "日本語",
    languageToggleLabel: "Show the page in Japanese",
  },

  help: {
    heading: "Help",
    intro:
      "A doll that guards the house: she wakes when someone comes near, lights her lantern and turns " +
      "slowly to see who it is. Most of this page works in this browser, without the real doll and without an account.",
    sections: [
      {
        title: "Try it in two minutes",
        items: [
          "Press “Try the web simulation”, then press one of the four buttons under “Call a visitor”.",
          "Each button plays one visit: a family member, a stranger at night, something that moves with no one there, and a lost network.",
          "Watch the State and Verdict labels change while the doll lights her lantern and turns her head.",
          "Every spoken line shows Japanese text with an English subtitle. Use Mute sound in the header at any time.",
        ],
      },
      {
        title: "About the Zashiki-Warashi",
        items: [
          "A zashiki-warashi is a child spirit from Japanese folklore. She lives in a room of an old house, protects it and brings good fortune to the people who live there.",
          "Legend says she is seen mostly by children, and that a house she leaves loses its luck. Here, the spirit lives in a traditional-style doll.",
          "When someone approaches, she wakes, lights her lantern and slowly turns her head to look at them. Slow turning is part of her character.",
          "She decides who it is: a family member gets a warm greeting in Japanese and a small nod. A stranger gets a silent stare, an eerie whisper or a nursery rhyme, and the family is notified.",
          "If she sees no face, is unsure, or loses the network, she asks a cautious “Is someone there?” and never freezes.",
          "She is a guardian art piece, not an alarm product. She is spooky but friendly: no threats and no violence.",
          "Inside the doll are a Raspberry Pi, a motion sensor, a camera, two small servos for the head and a lantern light. Face recognition and speech run in the cloud.",
        ],
      },
      {
        title: "Without signing in (guest)",
        items: [
          "You can run the web simulation: a virtual doll in your browser that follows the same flow and messages as the real one. It never uses your real camera or microphone.",
          "You can play the four visit scenarios, read every line with its subtitle, mute the sound and switch the language.",
          "Today's diary shows the visits you simulated. They disappear when you close the page.",
          "You cannot talk to the doll, use the Extra features switch, see real visits, control the real doll or manage faces. Those controls are shown locked.",
        ],
      },
      {
        title: "After signing in (demo account)",
        items: [
          "The demo account is a guest in someone's home, so it is read-only for everything real.",
          "Extra features: the same visits run through the real cloud (face search and speech) instead of the bundled answers.",
          "Talk: you can have a short voice conversation with the virtual doll, a few times per day.",
          "Today's diary can list real visits with illustrations instead of photos, unless the owner has hidden them. Remote control lets you watch the real doll's state.",
          "It cannot move the real doll, make her speak, take photos, manage faces or see real snapshots.",
        ],
      },
      {
        title: "After signing in (family)",
        items: [
          "Family members see everything about their own doll: real visits with their snapshots (deleted after a few days), and the doll's current state, head angle and lantern.",
          "Remote control: look left or right, set the lantern brightness, make her say one of her cached lines, pause guarding and set it back.",
          "Take a photo: she wakes, lights her lantern, takes one picture and goes back to waiting. Only the family can see it.",
          "Make the doll speak: type a Japanese line (up to 60 characters) and she says it aloud, even when she is waiting. She speaks to whoever is near her, so do not type names or private details.",
          "Talk through the real doll: a voice conversation using the doll's own microphone and speaker. See “How to talk to the doll”.",
          "Residents: register your own face with a consent notice, add more photos, and delete a face at any time. A registered face is how she knows family from strangers.",
          "You are notified when she meets a stranger.",
        ],
      },
      {
        title: "Remote control of the real doll",
        items: [
          "Open Remote control from the menu and sign in as family. The page shows whether the doll is online, her state, the mode, head angle and lantern.",
          "While she waits quietly she cannot move. Press “Start remote control” to wake her, then use the controls.",
          "Remote control ends by itself after two minutes without a command, or when you press “Set back to guard mode”. She then returns her head to center and fades the lantern.",
          "After you send a command, the page says it was sent and then whether the doll accepted it. If she is busy or talking, she refuses, and the page tells you to try again in a moment.",
          "An offline doll does not store commands, so nothing plays later.",
          "The camera and microphone indicator in the header always shows when the real doll is looking or listening.",
        ],
      },
      {
        title: "How to talk to the doll",
        items: [
          "Talking is for signed-in users. A guest sees “Sign in to talk to the doll.”",
          "Web simulation: press “Talk” and allow the microphone when the browser asks. The button changes to “Connecting…”. Wait until “Microphone on” appears. That is the moment to speak.",
          "The doll does not speak first. She waits quietly until you say something in Japanese, for example 「こんにちは」. Her answer appears as subtitles, and you can speak again when she finishes.",
          "Real doll (family only): open Remote control and press “Talk through the real doll”. This page only shows subtitles. Speak to the doll herself, within about 1 meter, once the header shows “Microphone on”.",
          "The real doll can also offer a conversation by herself. When she recognizes a family member, she says her greeting first, and starts listening only after the greeting ends. Wait for it to finish, then speak.",
          "If nobody speaks for about 15 seconds, the conversation ends. It also ends after 3 minutes, when you press Stop, when you close the page, or when the doll sees someone she does not know.",
          "Each account can start only a limited number of conversations per day. The number left is shown next to the button.",
          "Your voice goes to Amazon Bedrock in Tokyo and is not stored.",
          "If the button is disabled, the reason is written under it: signed out, offline, switched off, or today's time used up.",
        ],
      },
      {
        title: "Today's diary and Residents",
        items: [
          "Today's diary lists the visits you simulated, and for signed-in users the visits of the real doll.",
          "Residents lets family members register their own faces with a consent notice, and delete them at any time.",
        ],
      },
      {
        title: "Privacy",
        items: [
          "The header always shows whether the real doll's camera or microphone is in use.",
          "Snapshots stay in the owner's AWS account and expire within days. Names are never shown or spoken to a stranger.",
          "The doll does not record continuous video or audio.",
          "Faces are registered only by the family themselves, with consent, and can be deleted.",
        ],
      },
      {
        title: "Language",
        items: ["The 日本語 button in the header switches to Japanese, and English switches back. Every page changes, including this one, and this browser remembers the choice."],
      },
    ],
  },
} as const;

/** The shape both languages share: the English text widened to plain strings. */
type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => R
    : T extends readonly (infer U)[]
      ? readonly Widen<U>[]
      : { readonly [K in keyof T]: Widen<T[K]> };

export type Copy = Widen<typeof EN>;

export type Lang = "en" | "ja";
export const LANGS: readonly Lang[] = ["en", "ja"];

const COPIES: Readonly<Record<Lang, Copy>> = { en: EN, ja: JA };

/** The current language's text. Read it at render time. */
export let COPY: Copy = EN;
let current: Lang = "en";

/** Switches every later read of `COPY`. The caller re-renders. */
export function setLanguage(lang: Lang): void {
  current = lang;
  COPY = COPIES[lang];
}

export function currentLanguage(): Lang {
  return current;
}

/** The text of one language, for tests and for code that must not depend on the switch. */
export function copyFor(lang: Lang): Copy {
  return COPIES[lang];
}
