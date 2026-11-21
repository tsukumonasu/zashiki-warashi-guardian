/**
 * Every fixed UI string of the dashboard, in one place (Requirement 18.5).
 *
 * The wording is copied from `.kiro/specs/dashboard-simulation/requirements.md`. UI copy is
 * English with Japanese accents; the doll's spoken lines live in the voice catalog, not here.
 * Pure data: no React, no side effects.
 */
import { INDICATOR_TEXT } from "../simulation/indicator";

export const COPY = {
  landing: {
    titleKanji: "座敷童子",
    titleReading: "Zashiki-warashi",
    titleTranslation: "The child spirit of the house",
    // Exactly two sentences (Requirement 1.1).
    legend:
      "In old Iwate farmhouses, a child spirit called the zashiki-warashi is said to guard the house and bring it good fortune. " +
      "This doll wakes when someone draws near, lights her lantern, and turns slowly to see who has come.",
    enter: "Enter the house",
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
    heading: "The house",
    scenariosHeading: "Call a visitor",
    stateLabel: "State",
    verdictLabel: "Verdict",
    noVerdict: "No verdict yet",
    states: {
      sleeping: "Sleeping",
      waking: "Waking",
      seeking: "Looking for someone",
      gazing: "Gazing",
      greeting: "Greeting",
      warning: "Warning",
      uncertain: "Unsure",
      conversing: "Talking",
      cooldown: "Settling down",
    },
  },

  timeline: {
    simulatedHeading: "Simulated visits",
    realHeading: "Real visits",
    familyNotified: "Family notified",
    // Visible note so the label never claims a real notification (design D13).
    familyNotifiedNote: "(simulated, nothing was sent)",
    liveCloudLabel: "Live cloud",
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
    switchLabel: "Live cloud",
    generateLabel: "Generate a new line",
    networkDown: "No cloud call: the network is down",
    rateLimited: (seconds: number): string => `The cloud needs a rest. Try again in ${seconds} seconds.`,
    noAnswer: "The cloud did not answer",
    runInSimulation: "Run in Simulation mode",
    measuredInBrowser: "Durations measured in the browser",
  },

  device: {
    awake: "Awake",
    asleepOrOutOfReach: "The doll is asleep or out of reach",
    neverSeen: "never seen",
    motionOff: "Motion is switched off on the doll",
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
    sleep: "Put the doll to sleep",
    wake: "Wake the guard",
    sent: "Sent to the doll",
    offline: "The doll is offline. The command was not stored and will not play later.",
    tryAgain: "Try again",
    lockedControls: "This is someone's home. Only the family can call the doll.",
  },

  family: {
    lockedFaces: "This is someone's home. Only the family can manage faces.",
    register: "Register",
    delete: "Delete",
    oneFace: "The photo must show exactly one face.",
    storedNote: "Faces are stored only in your AWS account and can be deleted at any time.",
    heading: "Family faces",
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
    starting: "Connecting…",
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
  },

  shell: {
    skipToContent: "Skip to content",
    nav: { landing: "Home", house: "The house", timeline: "Timeline", family: "Family" },
    mute: "Mute sound",
    unmute: "Sound on",
    soundOn: "Sound: on",
    soundMuted: "Sound: muted",
    realDollHeading: "The real doll",
    offlineBanner: "Offline: the simulation still works",
    offlineLive: "Offline: Live cloud needs a connection.",
    offlineFaces: "Offline: face changes need a connection.",
    errorBoundary: "The doll lost her thread. Reload to start again.",
  },
} as const;

export type Copy = typeof COPY;
