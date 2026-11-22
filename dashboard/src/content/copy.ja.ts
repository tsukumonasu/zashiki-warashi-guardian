/**
 * Japanese translation of the dashboard's fixed UI strings (`copy.ts` holds the English source).
 *
 * The type `Copy` is the English shape, so a missing or extra key fails `tsc`. UI copy is plain,
 * polite Japanese; it is not the doll's voice. Type-only import: no runtime cycle with `copy.ts`.
 */
import type { Copy } from "./copy";

export const JA: Copy = {
  landing: {
    titleKanji: "座敷童子",
    titleReading: "ざしきわらし",
    titleTranslation: "家を守る子どもの妖怪",
    // Exactly two sentences, like the English legend (Requirement 1.1).
    legend:
      "岩手の古い農家には、座敷童子という子どもの妖怪がいて、家を守り福をもたらすと言い伝えられています。" +
      "この人形は誰かが近づくと目を覚まし、行灯をともし、ゆっくり振り向いて訪れた人を確かめます。",
    enter: "WEBシミュレーションを体験する",
    signIn: "サインイン",
    configUnavailable: "現在、クラウドの機能は使えません",
  },

  scenarios: {
    family_home: "家族が帰ってくる",
    stranger_night: "夜に見知らぬ人が入ってくる",
    nobody_there: "何かが動いたが、誰もいない",
    network_down: "ネットワークが切れている",
    stop: "止める",
  },

  verdicts: {
    family: "家の人",
    stranger: "しらない人",
    no_face: "顔なし",
    uncertain: "わからない",
    offline: "オフライン",
  },

  house: {
    heading: "WEBシミュレーション",
    intro:
      "リアルの人形が手元にない方向けの、ブラウザ上のシミュレーション画面です。右のボタンで訪問者を呼ぶと、仮想の人形が本物と同じ流れで反応します。",
    scenariosHeading: "訪問者を呼ぶ",
    stateLabel: "状態",
    verdictLabel: "判定",
    noVerdict: "まだ判定はありません",
    states: {
      sleeping: "眠っている",
      waking: "目覚めている",
      seeking: "人を探している",
      gazing: "見つめている",
      greeting: "迎えている",
      warning: "警戒している",
      uncertain: "迷っている",
      conversing: "話している",
      cooldown: "落ち着いている",
    },
  },

  realDollPage: {
    intro:
      "ラズパイで動いている、本物の人形の管理画面です。人形の状態を確認したり、ここから動かしたりできます。",
    signInNeeded: "本物の人形を見たり動かしたりするには、右上から家族としてサインインしてください。",
    needFamily: "本物の人形を動かせるのは家族だけです。状態は見ることができます。",
  },
  tips: {
    simulation: "ブラウザ上の仮想の人形です。本物の人形がなくても、訪問者への反応の流れを試せます。実際のカメラやマイクは使いません。",
    realDoll: "お手元にある本物の人形の状態と操作です。家族としてサインインすると使えます。",
    diary: "人形が見た訪問を、人形自身のひとことつきで並べた日記です。",
    simulatedDiary: "WEBシミュレーションで試した訪問の記録です。この画面を閉じると消えます。",
    realDiary: "本物の人形が出会った訪問の記録です。家族としてサインインすると見られます。",
    residents: "人形が「家の人」と見分けるために、顔を登録します。登録は本人の同意が必要で、いつでも削除できます。",
    verdict: "人形の判定です。家の人、しらない人、顔なし、わからない、オフラインのどれかです。",
    state: "人形がいま何をしているかです。眠る、起きる、探す、見つめる、などがあります。",
  },
  diary: {
    comments: {
      family: ["いえの ひとが かえってきた。おかえりって いえたよ。", "だいすきな ひとたちが もどってきて、ほっとした。"],
      stranger: ["しらない ひとが いた。こわかった。", "しらない ひとが すぐそばに いた。ずっと みていたよ。"],
      strangerNotified: [
        "しらない ひとが いた。こわかったから、みんなに しらせたよ。",
        "しらない ひとだった。ちゅうい してって つたえたよ。",
      ],
      no_face: ["だれか いた きがするけど、かおが みえなかった。", "かげが とおりすぎた。かおは みえなかった。"],
      uncertain: ["だれだか よく わからなかった。ちょっと ふあん。", "よく みたけど、やっぱり わからなかった。"],
      offline: ["おそとと つながらなくて、じぶんで きめたよ。", "しずかだった。ひとりで できる ことを したよ。"],
      unknown: ["うとうと していて、よく おぼえて いない。", "ねむくて ぼんやり していたよ。"],
    },
  },
  timeline: {
    pageTitle: "今日の日記",
    simulatedHeading: "WEBシミュレーションの訪問",
    realHeading: "本物の人形の訪問",
    columns: { time: "時刻", verdict: "判定", diary: "日記", notes: "備考" },
    familyNotified: "家族に通知",
    familyNotifiedNote: "(シミュレーションです。実際には送信していません)",
    liveCloudLabel: "ライブクラウド",
    showOlder: "古い訪問を表示",
    snapshotExpired: "スナップショットは期限切れです",
    empty: "まだ訪問はありません",
    loadFailed: "人形の記録を読み込めませんでした",
    tryAgain: "もう一度試す",
    hiddenFromGuests: "持ち主が実際の訪問をゲストに非表示にしています。代わりにシナリオをお試しください。",
  },

  roles: {
    visitor: "ゲスト",
    reviewer: "審査員",
    family: "家族",
    signedOutAgain: "もう一度サインインしてください",
    forbidden: "ここは誰かの家です。この場所はゲストには開かれていません。",
    signOut: "サインアウト",
  },

  live: {
    switchLabel: "ライブクラウド",
    generateLabel: "新しいセリフを生成する",
    networkDown: "クラウドを呼んでいません: ネットワークが切れています",
    rateLimited: (seconds: number): string => `クラウドは休憩中です。${seconds} 秒後にもう一度お試しください。`,
    noAnswer: "クラウドから応答がありませんでした",
    runInSimulation: "シミュレーションで実行する",
    measuredInBrowser: "所要時間はブラウザで計測しています",
  },

  device: {
    awake: "起きている",
    asleepOrOutOfReach: "人形は眠っているか、つながっていません",
    neverSeen: "未接続",
    motionOff: "人形の動きは無効になっています",
  },

  privacy: {
    simulation: "シミュレーション: 実際のカメラとマイクは使っていません",
    unknown: "カメラとマイクの状態は不明です",
    off: "カメラ オフ、マイク オフ",
    cameraOn: "カメラ オン",
    microphoneOn: "マイク オン",
  },

  controls: {
    lookLeft: "左を見る",
    lookRight: "右を見る",
    sleep: "人形を眠らせる",
    wake: "見張りを起こす",
    sent: "人形に送りました",
    offline: "人形はオフラインです。コマンドは保存されず、あとで実行されることもありません。",
    tryAgain: "もう一度試す",
    lockedControls: "ここは誰かの家です。人形を呼べるのは家族だけです。",
  },

  family: {
    lockedFaces: "ここは誰かの家です。顔を管理できるのは家族だけです。",
    register: "登録する",
    delete: "削除",
    oneFace: "写真には顔がちょうど1つ写っている必要があります。",
    storedNote: "顔はあなたの AWS アカウントだけに保存され、いつでも削除できます。",
    heading: "家の人間たち",
    pageTitle: "住人設定",
    columns: { name: "名前", photos: "写真", added: "登録日", actions: "操作" },
    noMembers: "まだ顔は登録されていません",
    loadFailed: "顔の一覧を読み込めませんでした",
    noticeOutOfDate: "この同意事項は古くなっています。ページを再読み込みしてください。",
    consentLabel: "写真の本人がこの利用に同意しています",
    nameLabel: "表示名(1〜40文字)",
    photoLabel: "写真(JPEG または PNG、5 MB まで)",
    addToLabel: "追加先",
    newMember: "新しいメンバー",
    previewAlt: "選んだ写真のプレビュー",
    consentAgain: "同意事項が変わりました。読んでから、もう一度確認してください。",
    registered: "顔を登録しました",
    registerFailed: "顔を登録できませんでした。もう一度お試しください。",
    deleteFailed: "顔を削除できませんでした。もう一度お試しください。",
    deleteTitle: (name: string): string => `${name} を削除しますか？`,
    deleteBody: "顔のベクトルとメンバーの記録が削除されます。",
    confirmDelete: "削除",
    cancel: "キャンセル",
  },

  talk: {
    heading: "人形と話す",
    notice: "人形が答えるために、あなたの声は東京リージョンの Amazon Bedrock に送られます。声は保存されません。",
    talk: "話す",
    talkReal: "本物の人形を通して話す",
    stop: "止める",
    starting: "接続しています…",
    ending: "会話を終えています…",
    micOn: "マイク オン",
    watching: "本物の人形が聞いています。このページには字幕だけが表示されます。",
    subtitlesLabel: "字幕",
    you: "あなた",
    doll: "人形",
    remainingToday: (n: number): string => `今日はあと ${n} 回話せます`,
    tryAgain: "もう一度試す",
    disabled: {
      visitor: "人形と話すにはサインインしてください。",
      unknown: "今は話すことができません。",
      off: "現在、会話は停止されています。",
      noRole: "このアカウントでは会話を始められません。",
      none: "今日の会話の回数を使い切りました。また明日お試しください。",
      offline: "オフラインです。会話にはネットワーク接続が必要です。",
    },
    errors: {
      rate_limited: "今日の会話の回数を使い切りました。また明日お試しください。",
      session_active: "人形はすでに会話中です。",
      voice_unavailable: "現在、会話は停止されています。",
      forbidden: "このアカウントでは会話を始められません。",
      unauthorized: "もう一度サインインしてください。",
      microphone: "マイクを使えませんでした。ブラウザの許可を確認して、もう一度お試しください。",
      connection: "音声の接続に失敗しました。もう一度お試しください。",
      other: "会話を始められませんでした。もう一度お試しください。",
    },
    ended: {
      silence: "しばらく静かだったので、会話を終えました。",
      limit: "会話の時間の上限に達しました。",
      stranger: "人形が知らない人を見つけたので、会話を終えました。",
      user: "あなたが会話を終えました。",
      manual: "会話は手動で終了されました。",
      language: "会話を終えました: 人形は日本語しか話しません。",
      unsafe_output: "なごやかな会話を保つため、会話を終えました。",
      error: "エラーのため、会話を終えました。",
      no_client: "会話を終えました: 聞いている人がいませんでした。",
      offline: "人形がオフラインになったので、会話を終えました。",
    },
  },

  locked: {
    visitor: "本物の人形を見るにはサインインしてください。",
  },

  signIn: {
    heading: "サインイン",
    username: "ユーザー名",
    password: "パスワード",
    submit: "サインイン",
    cancel: "キャンセル",
    working: "サインインしています…",
    failed: "サインインに失敗しました。ユーザー名とパスワードを確認してください。",
    needsSetup: "このアカウントは設定が必要です。持ち主に連絡してください。",
    offline: "サインインのサービスにつながりません。接続を確認してください。",
    checking: "サインインを確認中…",
    signedInAs: "サインイン中:",
  },

  shell: {
    infoLabel: "これは何?",
    skipToContent: "本文へ移動",
    nav: { landing: "ホーム", house: "WEBシミュレーション", doll: "本物の人形", timeline: "今日の日記", family: "住人設定", help: "ヘルプ" },
    mute: "音を消す",
    unmute: "音を出す",
    soundOn: "音: オン",
    soundMuted: "音: オフ",
    realDollHeading: "本物の人形",
    offlineBanner: "オフラインです。シミュレーションはそのまま使えます",
    offlineLive: "オフラインです。ライブクラウドにはネットワーク接続が必要です。",
    offlineFaces: "オフラインです。顔の変更にはネットワーク接続が必要です。",
    errorBoundary: "人形が迷子になりました。再読み込みして、はじめからやり直してください。",
    languageToggle: "English",
    languageToggleLabel: "英語で表示する",
  },

  help: {
    heading: "ヘルプ",
    intro:
      "家を守る人形です。誰かが近づくと目を覚まし、行灯をともし、ゆっくり振り向いて相手を確かめます。" +
      "以下のことは、本物の人形がなくてもこのブラウザで試せます。",
    sections: [
      {
        title: "2分で試す",
        items: [
          "「家に入る」を選び、「訪問者を呼ぶ」の4つのボタンのどれかを押します。",
          "ボタンごとに1つの訪問が再生されます。家族、夜の見知らぬ人、誰もいないのに何かが動く、ネットワークが切れている、の4つです。",
          "人形が行灯をともして首を回すあいだ、「状態」と「判定」の表示が変わっていきます。",
          "人形のセリフには、日本語の文と英語の字幕が表示されます。ヘッダーの「音を消す」でいつでも消音できます。",
        ],
      },
      {
        title: "サインイン(任意)",
        items: [
          "サインインすると「ライブクラウド」のスイッチが使えます。同じ訪問を本物のクラウド(顔の検索と音声合成)で実行します。",
          "デモ用アカウントは、誰かの家に招かれたゲストです。本物の人形を動かすこと、顔の管理、実際のスナップショットの閲覧はできません。",
        ],
      },
      {
        title: "人形と話す",
        items: [
          "「話す」を押し、ブラウザにマイクの許可を求められたら許可します。",
          "先に、日本語で話しかけてください。人形はあなたが話すまで静かに待っています。たとえば「こんにちは」と言ってみてください。",
          "あなたの声は東京リージョンの Amazon Bedrock に送られ、保存されません。話しているあいだ字幕が表示されます。",
          "しばらく静かになるか、時間の上限に達すると会話は終わります。1日に話せる回数には上限があります。",
        ],
      },
      {
        title: "今日の日記と住人設定",
        items: [
          "「今日の日記」には、ためしの訪問と、サインインしている場合は本物の人形の訪問が並びます。",
          "「住人設定」では、家の人間が同意事項を読んだうえで自分の顔を登録でき、いつでも削除できます。",
        ],
      },
      {
        title: "プライバシー",
        items: [
          "ヘッダーには、本物の人形のカメラとマイクを使っているかどうかが常に表示されます。",
          "スナップショットは持ち主の AWS アカウントにだけ保存され、数日で消えます。見知らぬ人に名前が表示されることはありません。",
        ],
      },
      {
        title: "言語",
        items: ["ヘッダーの「English」ボタンで英語に、「日本語」ボタンで日本語に切り替わります。このページも含め、すべてのページが切り替わります。選んだ言語はこのブラウザに保存されます。"],
      },
    ],
  },
};
