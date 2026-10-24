import type { ExternalMediaSource } from "../../external_player/external-media";
import { escapeHtml as esc } from "../../html";
import { consentSwitch, noteToggle } from "../../panel-rows";
import type { DebugState, NeteasePlaylist } from "../data/queue";
import { isNeteaseSource } from "./player";

/** The debugging port as its row says it in a word or two (PORT_WORDS); its sentence is under 说明. */
export type PortState = "on" | "fm" | "probing" | "closed" | "noreply" | "error" | "restarting";
export const PORT_WORDS: Record<PortState, string> = {
  on: "已连接", fm: "已连接 · 私人 FM", probing: "正在检测…", closed: "未开启",
  noreply: "没有回应", error: "出错", restarting: "正在重新启动…",
};
/** A state the user can do something about (the 播放器 panel marks 网易云 in its index). */
export const PORT_NEEDS_LOOK: readonly PortState[] = ["closed", "noreply", "error"];

export interface QueueControl {
  /** NetEase's debugging port answered the last poll. */
  available: boolean;
  status: string;
  /** A poll found the port closed: offer to restart NetEase with it. */
  restart: boolean;
  state: PortState;
}
/**
 * `playKey`: the key the user gave 播放选中的歌 (设置 → 快捷键; P by default, "" for none). These
 * sentences name it; with P they read word for word as the owner approved them (the owner,
 * 2026-10-11: "yes keep every key changable", P included).
 */
export function queueControlStatus(control: Pick<QueueControl, "available">, debug?: DebugState, playKey = "P") {
  if (!control.available) return `未检测到网易云调试端口（9233）。以调试端口启动网易云后，点 ▶${playKey ? ` 或按 ${playKey}` : ""} 才能播放选中的歌。`;
  return debug?.mode === "playFm"
    ? "已连接网易云调试端口。私人 FM 模式下不能播放队列或歌单中的歌。"
    : `已连接网易云调试端口：浏览时不切歌，点 ▶${playKey ? `（或按 ${playKey}）` : " "}时网易云播放选中的歌。`;
}

/**
 * What the panel says about a playlists read. A playlist NetEase has not saved on this PC
 * appears once it is opened there; one the reader's limits cut does not, and is not counted
 * as waiting. `truncated` is the reply's own flag (more playlists or songs than the limits).
 */
export function playlistSummary(playlists: readonly NeteasePlaylist[], truncated: boolean) {
  const filled = playlists.filter((playlist) => playlist.tracks.length).length;
  const waiting = playlists.filter((playlist) => playlist.trackCount > 0 && !playlist.tracks.length && !playlist.truncated).length;
  const cut = truncated || playlists.some((playlist) => playlist.truncated)
    ? "超过上限（200 个歌单、每个 3,000 首、合计 12,000 首）的部分没有显示。" : "";
  return filled
    ? `已读取 ${filled} 个歌单${waiting ? `；另有 ${waiting} 个歌单在这台电脑上还没有歌曲数据，在网易云里打开或播放一次后出现` : ""}。${cut}`
    : `网易云在这台电脑上还没有保存任何歌单的歌曲。在网易云里打开或播放一个自己的歌单后出现。${cut}`;
}

/**
 * The 播放器 panel's 网易云 section (the panels' redesign, 2026-10-24): one line a setting, its
 * consent word for word under 说明 (panel-rows.ts), in the order the consents refer to (见下方 /
 * 见上方): the queue, the debugging port, the playlist columns.
 */
export function queueSettingMarkup(source: ExternalMediaSource | undefined, enabled: boolean, status: string, control: QueueControl,
  playlists: { enabled: boolean; status: string } = { enabled: true, status: "" }, playKey = "P") {
  const key = esc(playKey);
  if (!isNeteaseSource(source)) return "";
  const queue = consentSwitch("netease-queue", "显示网易云播放队列", "读取网易云保存在本机的当前播放队列，仅取歌曲编号、歌名、歌手、专辑、时长和封面地址；封面从网易云公开图片服务器加载。不读取账号、Cookie、播放历史或本地歌曲路径。打开后默认同时按歌单分列（读取本机歌单，见下方），可单独关闭。",
    enabled, `<p class="external-note" data-queue-status role="status">${esc(status)}</p>`);
  if (!enabled) return queue;
  // The debugging port is no switch (the owner, 2026-10-09: "do not make this a setting option"): its
  // state in a word, what it is used for and its full status under 说明, and the restart when a probe
  // found it closed.
  return `${queue}<div class="consent-group external-debug-port"><div class="settings-row consent-row"><span class="consent-name"><span>调试端口</span>${noteToggle("netease-debug-note", "调试端口")}</span><span class="port-state" data-debug-state="${control.state}" title="${esc(control.status)}" role="status">${PORT_WORDS[control.state]}</span></div><div class="consent-note" id="netease-debug-note" hidden><p>浏览时不切歌。以调试端口启动网易云后，点队列中一首歌的 ▶（或${key ? `选中它后按 ${key}、` : ""}打开它的详情），通过网易云的调试端口（仅本机 127.0.0.1:9233）让它播放这首歌，不改变队列顺序；点其他歌单里一首歌的 ▶（同样可${key ? `按 ${key}、` : ""}打开详情），让网易云从这首歌开始播放这个歌单，与在网易云的歌单里双击这首歌相同：网易云的播放队列换成这个歌单，歌单的编号与名称交给网易云作为队列的来源。同时显示播放进度，并可拖动进度条。正在播放的歌的详情里显示它的歌词：Rhine 请网易云载入这首歌的歌词（与打开网易云的播放页时相同，网易云从它的缓存或服务器取得，界面不变），再读取每行歌词的时间、文字、翻译与逐字时间；只读取正在播放的这首歌的歌词，只留在 Rhine 的内存里，不保存、不发送。端口开启期间，本机其他程序也能控制网易云。</p><p class="consent-status" data-debug-status>${esc(control.status)}</p></div><div class="port-restart" data-debug-restart${control.restart ? "" : " hidden"}><button id="netease-restart-debug" data-action="netease-restart-debug">以调试端口重新启动网易云</button></div></div>${consentSwitch("netease-playlists", "按歌单分列", "默认打开。读取网易云保存在本机的歌单数据（Library\\webdb.dat，只读），仅取你创建的歌单（含“我喜欢的音乐”）的编号、名称、歌曲数与封面地址，以及其中歌曲的编号、歌名、歌手、专辑、时长和封面地址；并使用播放队列的来源歌单编号与名称。每个有歌曲数据的歌单是一列，列旁标出歌单名称，专辑架右侧的歌单列表也列出名称与歌曲数；正在播放的那个歌单显示播放队列本身；其余各列里点一首歌的 ▶，网易云从这首歌开始播放那个歌单（见上方的网易云调试端口）。不读取收藏的歌单、账号、Cookie 或播放历史。Rhine 不保存歌单名称和歌曲列表；封面图片从网易云公开图片服务器加载，会留在界面缓存里。",
    playlists.enabled, `<p class="external-note" data-playlist-status role="status">${esc(playlists.enabled ? playlists.status : "")}</p>`)}`;
}
