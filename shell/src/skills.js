// AUF 技能数据 (顺序即面板顺序; 修改后发版即全员生效)
// pid = bossassis 协议 timerId; labelEn = 英文界面显示名; voice = 中文语音文本; voiceEn = 英文语音文本
export const SKILLS = [
  { id: "mdr",  pid: "mainDR",  label: "反伤·主", labelEn: "MDR",  cd: 60, warn: 5, color: "#b95cff", voice: "主体反伤好了", voiceEn: "Main DR ready" },
  { id: "mdp",  pid: "mainDP",  label: "DP·主",   labelEn: "MDP",  cd: 90, warn: 5, color: "#ff4d4d", voice: "主体DP好了",   voiceEn: "Main DP ready" },
  { id: "sed",  pid: "sed",     label: "诱惑",    labelEn: "SED",  cd: 30, warn: 5, color: "#ffa930", voice: "诱惑好了",     voiceEn: "Seduce ready" },
  { id: "stun", pid: "stun",    label: "眩晕",    labelEn: "STUN", cd: 60, warn: 5, color: "#4dd2ff", voice: "眩晕好了",     voiceEn: "Stun ready" },
  { id: "cdr",  pid: "cloneDR", label: "反伤·分", labelEn: "CDR",  cd: 60, warn: 5, color: "#c9a0ff", voice: "分身反伤好了", voiceEn: "Clone DR ready" },
  { id: "cdp",  pid: "cloneDP", label: "DP·分",   labelEn: "CDP",  cd: 60, warn: 5, color: "#ff8fa3", voice: "分身DP好了",   voiceEn: "Clone DP ready" },
];

export const BOSS = "auf";

export const DEFAULT_KEYBINDS = {
  lock: "Control+Alt+L",
};
