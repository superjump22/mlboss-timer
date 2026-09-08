// Boss 技能数据层 (三副本; pid = bossassis 协议 timerId, 已与原版网页逐一核对)
// skill: { id, pid, label, labelEn, cd, warn, color, tint?, voice, voiceEn, nameable? }
// - nameable: PB 的 R/TL 位 (名字纯本地存储, 服务器不同步 — 见交接文档 3.3 实测结论)
// - label 即 nameable 格子的占位符 (无自定义名字时显示)
// - tint (HT): 格子背景色 = 部位区分; color = 技能名色 = 类型区分 (SED 橙 / MESS 蓝 / DP 红)
// - timeFmt 默认值按原版网页: AUF 纯秒数, PB/HT 分秒 (cd≥60)
// 语音措辞与 scripts/gen_voices.py 短语表保持一致

export const BOSSES = {
  auf: {
    id: "auf",
    label: "AUF",
    full: "Aufheben",
    color: "#b95cff",
    timeFmt: "sec", // 原版网页: 纯秒数
    groups: [
      {
        id: "main",
        label: "主体",
        labelEn: "Main",
        skills: [
          { id: "mdr", pid: "mainDR", label: "反伤·主", labelEn: "MDR", cd: 60, warn: 5, color: "#b95cff", voice: "主体反伤好了", voiceEn: "Main DR ready" },
          { id: "mdp", pid: "mainDP", label: "DP·主", labelEn: "MDP", cd: 90, warn: 5, color: "#ff4d4d", voice: "主体DP好了", voiceEn: "Main DP ready" },
          { id: "sed", pid: "sed", label: "诱惑", labelEn: "SED", cd: 30, warn: 5, color: "#ffa930", voice: "诱惑好了", voiceEn: "Seduce ready" },
          { id: "stun", pid: "stun", label: "眩晕", labelEn: "STUN", cd: 60, warn: 5, color: "#4dd2ff", voice: "眩晕好了", voiceEn: "Stun ready" },
        ],
      },
      {
        id: "clone",
        label: "分身",
        labelEn: "Clone",
        skills: [
          { id: "cdr", pid: "cloneDR", label: "反伤·分", labelEn: "CDR", cd: 60, warn: 5, color: "#c9a0ff", voice: "分身反伤好了", voiceEn: "Clone DR ready" },
          { id: "cdp", pid: "cloneDP", label: "DP·分", labelEn: "CDP", cd: 60, warn: 5, color: "#ff8fa3", voice: "分身DP好了", voiceEn: "Clone DP ready" },
        ],
      },
    ],
  },

  pb: {
    id: "pb",
    label: "PB",
    full: "Pink Bean",
    color: "#ff8fd0",
    timeFmt: "ms", // 原版网页: m:ss (R1 = 30:00)
    supportHidden: true, // 有"显示支援技能"开关 (R/TL 位)
    groups: [
      {
        id: "common",
        label: "常规",
        labelEn: "Common",
        skills: [
          { id: "dr", pid: "dr", label: "反伤", labelEn: "DR", cd: 60, warn: 5, color: "#b95cff", voice: "反伤好了", voiceEn: "DR ready" },
          { id: "zombie", pid: "zombie", label: "僵尸", labelEn: "Zombify", cd: 120, warn: 5, color: "#9dff57", voice: "僵尸好了", voiceEn: "Zombie ready" },
          { id: "sed", pid: "sed", label: "诱惑", labelEn: "SED", cd: 40, warn: 5, color: "#ffa930", voice: "诱惑好了", voiceEn: "Sed ready" },
          { id: "mini", pid: "mini", label: "mini", labelEn: "Mini", cd: 60, warn: 5, color: "#4dd2ff", voice: "mini好了", voiceEn: "mini ready" },
        ],
      },
      {
        id: "res",
        label: "复活术",
        labelEn: "Res",
        support: true, // 支援技能位 (可被"显示支援技能"开关隐藏)
        skills: [
          { id: "ress1", pid: "ress1", label: "R1", labelEn: "R1", cd: 1800, warn: 5, color: "#7ce38b", voice: "R1好了", voiceEn: "R1 ready", nameable: true },
          { id: "ress2", pid: "ress2", label: "R2", labelEn: "R2", cd: 1800, warn: 5, color: "#7ce38b", voice: "R2好了", voiceEn: "R2 ready", nameable: true },
          { id: "ress3", pid: "ress3", label: "R3", labelEn: "R3", cd: 1800, warn: 5, color: "#7ce38b", voice: "R3好了", voiceEn: "R3 ready", nameable: true },
          { id: "ress4", pid: "ress4", label: "R4", labelEn: "R4", cd: 1800, warn: 5, color: "#7ce38b", voice: "R4好了", voiceEn: "R4 ready", nameable: true },
          { id: "ress5", pid: "ress5", label: "R5", labelEn: "R5", cd: 1800, warn: 5, color: "#7ce38b", voice: "R5好了", voiceEn: "R5 ready", nameable: true },
        ],
      },
      {
        id: "tl",
        label: "伺机待发",
        labelEn: "TL",
        support: true,
        skills: [
          { id: "tl1", pid: "tl1", label: "TL1", labelEn: "TL1", cd: 1200, warn: 5, color: "#64dfdf", voice: "TL1好了", voiceEn: "TL1 ready", nameable: true },
          { id: "tl2", pid: "tl2", label: "TL2", labelEn: "TL2", cd: 1200, warn: 5, color: "#64dfdf", voice: "TL2好了", voiceEn: "TL2 ready", nameable: true },
          { id: "tl3", pid: "tl3", label: "TL3", labelEn: "TL3", cd: 1200, warn: 5, color: "#64dfdf", voice: "TL3好了", voiceEn: "TL3 ready", nameable: true },
        ],
      },
    ],
  },

  // HT 组序 = 左手 → 中头 → 右手 (符合 boss 形象: 左 中 右)
  // 部位 tint (格子背景): 左暖 / 中紫 / 右冷; 类型色 (技能名): SED 橙 / MESS 蓝 / DP 红
  ht: {
    id: "ht",
    label: "HT",
    full: "Horntail",
    color: "#ff5c5c",
    timeFmt: "ms", // 原版网页: cd≥60 → m:ss
    groups: [
      {
        id: "la",
        label: "左手",
        labelEn: "Left Arm",
        tint: "rgba(255, 190, 100, 0.10)",
        skills: [
          { id: "laSed1", pid: "laSed1", label: "左手SED1", labelEn: "LA SED#1", cd: 180, warn: 5, color: "#ffa930", voice: "左手SED1好了", voiceEn: "LA SED 1 ready" },
          { id: "laSed2", pid: "laSed2", label: "左手SED2", labelEn: "LA SED#2", cd: 180, warn: 5, color: "#ffa930", voice: "左手SED2好了", voiceEn: "LA SED 2 ready" },
          { id: "laSed3", pid: "laSed3", label: "左手SED3", labelEn: "LA SED#3", cd: 180, warn: 5, color: "#ffa930", voice: "左手SED3好了", voiceEn: "LA SED 3 ready" },
          { id: "laMass", pid: "laMass", label: "左手MESS", labelEn: "LA MASS", cd: 60, warn: 5, color: "#4dd2ff", voice: "左手MESS好了", voiceEn: "LA MASS ready" },
          { id: "laDp1", pid: "laDp1", label: "左手DP1", labelEn: "LA DP#1", cd: 300, warn: 5, color: "#ff4d4d", voice: "左手DP1好了", voiceEn: "LA DP 1 ready" },
          { id: "laDp2", pid: "laDp2", label: "左手DP2", labelEn: "LA DP#2", cd: 180, warn: 5, color: "#ff4d4d", voice: "左手DP2好了", voiceEn: "LA DP 2 ready" },
        ],
      },
      {
        id: "mh",
        label: "中头",
        labelEn: "Mid Head",
        tint: "rgba(200, 130, 255, 0.10)",
        skills: [
          { id: "mhDp1", pid: "mhDp1", label: "中头DP1", labelEn: "MH DP#1", cd: 300, warn: 5, color: "#ff4d6d", voice: "中头DP1好了", voiceEn: "MH DP 1 ready" },
          { id: "mhDp2", pid: "mhDp2", label: "中头DP2", labelEn: "MH DP#2", cd: 180, warn: 5, color: "#ff4d6d", voice: "中头DP2好了", voiceEn: "MH DP 2 ready" },
        ],
      },
      {
        id: "ra",
        label: "右手",
        labelEn: "Right Arm",
        tint: "rgba(110, 190, 255, 0.10)",
        skills: [
          { id: "raSed1", pid: "raSed1", label: "右手SED1", labelEn: "RA SED#1", cd: 180, warn: 5, color: "#ffa930", voice: "右手SED1好了", voiceEn: "RA SED 1 ready" },
          { id: "raSed2", pid: "raSed2", label: "右手SED2", labelEn: "RA SED#2", cd: 180, warn: 5, color: "#ffa930", voice: "右手SED2好了", voiceEn: "RA SED 2 ready" },
          { id: "raSed3", pid: "raSed3", label: "右手SED3", labelEn: "RA SED#3", cd: 180, warn: 5, color: "#ffa930", voice: "右手SED3好了", voiceEn: "RA SED 3 ready" },
          { id: "raMass", pid: "raMass", label: "右手MESS", labelEn: "RA MASS", cd: 60, warn: 5, color: "#4dd2ff", voice: "右手MESS好了", voiceEn: "RA MASS ready" },
        ],
      },
    ],
  },
};

// boss 全部技能平铺 (悬浮窗过滤/语音预加载用)
export function skillsOf(bossId) {
  const b = BOSSES[bossId];
  if (!b) return [];
  return b.groups.flatMap((g) => g.skills);
}

// 当前活跃 boss (主窗口写 localStorage, 悬浮窗读; 见架构决策 4)
export function activeBossId() {
  const v = localStorage.getItem("activeBoss");
  return BOSSES[v] ? v : "auf";
}

// 时间格式 per-boss: timeFmt_{boss} → 旧全局 timeFmt (beta.9 迁移) → 原版默认
export function timeFmtOf(bossId) {
  const b = BOSSES[bossId] || BOSSES.auf;
  return (
    localStorage.getItem(`timeFmt_${bossId}`) || localStorage.getItem("timeFmt") || b.timeFmt
  );
}
