/**
 * Rows the panels share (the settings panel's design A, given to every panel 2026-10-24: "redesign
 * the connection panel and any other panel make it just like setting panel, it has tooo much words
 * now"). A consent stays word for word, folded under 说明 beside the switch it is for; the switch is
 * described by it (aria-describedby reads a folded note too). music-app.ts keeps which notes are open.
 */

/** 说明: opens and folds the note `note`; its name says whose (说明：调试端口), as several are in a row. */
export const noteToggle = (note: string, name: string) =>
  `<button type="button" class="consent-toggle" data-action="consent-note" aria-expanded="false" aria-controls="${note}" aria-label="说明：${name}">说明</button>`;

/**
 * A switch and its consent: the name and the switch on one line, the consent under 说明, then
 * `after` (the switch's status line). One rule under the group.
 */
export function consentSwitch(id: string, name: string, consent: string, on: boolean, after = "") {
  return `<div class="consent-group"><div class="settings-row consent-row"><span class="consent-name"><label for="${id}">${name}</label>${noteToggle(`${id}-note`, name)}</span><input type="checkbox" role="switch" class="settings-switch" id="${id}" aria-describedby="${id}-note"${on ? " checked" : ""}></div><div class="consent-note" id="${id}-note" hidden><p>${consent}</p></div>${after}</div>`;
}
