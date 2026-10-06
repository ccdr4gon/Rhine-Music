import type { ExternalMediaSource } from "../../external_player/external-media";
import { escapeHtml as esc } from "../../html";
import type { DebugState, NeteasePlaylist } from "../data/queue";
import { isNeteaseSource } from "./player";

export interface QueueControl {
  /** The user lets the play button ask NetEase, through its debugging port, to play the selected song. */
  enabled: boolean;
  /** NetEase's debugging port answered the last poll. */
  available: boolean;
  status: string;
  /** A poll found the port closed: offer to restart NetEase with it. */
  restart: boolean;
}
export function queueControlStatus(control: Pick<QueueControl, "enabled" | "available">, debug?: DebugState) {
  if (!control.enabled) return "";
  if (!control.available) return "未检测到网易云调试端口（9233）。以调试端口启动网易云后，点播放才能播放选中的歌。";
  return debug?.mode === "playFm"
    ? "已连接网易云调试端口。私人 FM 模式下不能播放队列中的歌。"
    : "已连接网易云调试端口：浏览时不切歌，点播放（或按空格）时网易云播放选中的歌。";
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

export function queueSettingMarkup(source: ExternalMediaSource | undefined, enabled: boolean, status: string, control: QueueControl,
  playlists: { enabled: boolean; status: string } = { enabled: true, status: "" }) {
  if (!isNeteaseSource(source)) return "";
  const queue = `<label class="settings-row external-queue-consent"><span>显示网易云播放队列<small>读取网易云保存在本机的当前播放队列，仅取歌曲编号、歌名、歌手、专辑、时长和封面地址；封面从网易云公开图片服务器加载。不读取账号、Cookie、播放历史或本地歌曲路径。打开后默认同时按歌单分列（读取本机歌单，见下方），可单独关闭。</small></span><input type="checkbox" id="netease-queue" ${enabled ? "checked" : ""}></label><p class="external-note" data-queue-status role="status">${esc(status)}</p>`;
  if (!enabled) return queue;
  return `${queue}<label class="settings-row external-queue-consent"><span>点播放时让网易云播放选中的歌<small>浏览时不切歌。选中队列中的一首歌后点播放（或按空格），通过网易云的调试端口（仅本机 127.0.0.1:9233）让它播放这首歌，不改变队列顺序；同时显示播放进度，并可拖动进度条。需要以调试端口启动网易云；端口开启期间，本机其他程序也能控制网易云。</small></span><input type="checkbox" id="netease-control" ${control.enabled ? "checked" : ""}></label><p class="external-note" data-debug-status role="status">${esc(control.status)}</p><div class="panel-actions" data-debug-restart ${control.restart ? "" : "hidden"}><button id="netease-restart-debug" data-action="netease-restart-debug">以调试端口重新启动网易云</button></div><label class="settings-row external-queue-consent"><span>按歌单分列<small>默认打开。读取网易云保存在本机的歌单数据（Library\\webdb.dat，只读），仅取你创建的歌单（含“我喜欢的音乐”）的编号、名称、歌曲数与封面地址，以及其中歌曲的编号、歌名、歌手、专辑、时长和封面地址；并使用播放队列的来源歌单编号与名称。每个有歌曲数据的歌单是一列，列旁标出歌单名称，专辑架右侧的歌单列表也列出名称与歌曲数；正在播放的那个歌单显示播放队列本身，其余各列只供浏览、不会切歌。不读取收藏的歌单、账号、Cookie 或播放历史。Rhine 不保存歌单名称和歌曲列表；封面图片从网易云公开图片服务器加载，会留在界面缓存里。</small></span><input type="checkbox" id="netease-playlists" ${playlists.enabled ? "checked" : ""}></label><p class="external-note" data-playlist-status role="status">${esc(playlists.enabled ? playlists.status : "")}</p>`;
}
