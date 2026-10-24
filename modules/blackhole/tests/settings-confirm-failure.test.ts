// Real host shape: openConfigFlow with the real createConfirm. After a confirmed Save / Reset / Delete whose handler
// throws, the nested confirm must be dismissed; otherwise it keeps swallowing every key and the modal is stuck.
import { describe, expect, it } from "vitest";
import { openConfigFlow } from "../src/pi-base/settings/config-flow.ts";

const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t, inverse: (t: string) => t } as never;
const tui = { terminal: { rows: 40, columns: 80 }, requestRender() {} } as never;
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

async function openEditMode(handlers: { save?: () => void; resetScope?: () => void; deleteScope?: () => void }) {
  const notifications: string[] = [];
  let body: any;
  let hostDone = false;
  const ctx: any = {
    hasUI: true,
    cwd: process.cwd(),
    ui: {
      notify: (message: string) => notifications.push(message),
      custom: (factory: any) => new Promise<void>((resolve) => { body = factory(tui, theme, {}, () => { hostDone = true; resolve(); }); }),
    },
  };
  const boom = (what: string) => () => { throw new Error(`${what} failed: the config file may be read-only`); };
  openConfigFlow({
    label: "pi-blackhole", ctx, cwd: process.cwd(),
    scopes: { global: true, project: false, session: false }, sessionInitialized: false, sessionNote: "",
    defaults: { memory: true },
    buildFields: (v: any) => [{ key: "memory", type: "boolean", label: "Memory", value: v.memory }] as never,
    layerValues: () => ({ memory: true }),
    inspect: () => ({ layers: {} as never, winners: {} }),
    scopeSources: () => [],
    save: handlers.save ?? boom("save"), resetScope: handlers.resetScope ?? boom("reset"), deleteScope: handlers.deleteScope ?? boom("delete"),
    onSaved: () => {},
  } as never);
  await tick();
  body.handleInput("\x1b[B"); body.handleInput("\r");
  for (let i = 0; i < 20 && typeof body?.mountOverlay !== "function"; i += 1) await tick();
  return { body, notifications, hostDone: () => hostDone, frame: () => body.render(80).join("\n") };
}

describe("a failing confirmed action does not leave a dead confirm frame mounted", () => {
  it("save", async () => {
    const flow = await openEditMode({});
    flow.body.handleInput("\x13"); await tick();
    expect(flow.frame()).toContain("Really save to Global?");
    flow.body.handleInput("\r"); await tick();
    expect(flow.notifications.join("\n")).toMatch(/save failed/);
    expect(flow.frame()).not.toContain("Really save to Global?");
  });

  it("reset", async () => {
    const flow = await openEditMode({});
    for (let i = 0; i < 3; i += 1) flow.body.handleInput("\t");
    flow.body.handleInput("\r"); await tick();
    expect(flow.frame()).toContain("Really reset Global to defaults?");
    flow.body.handleInput("\x1b[C"); flow.body.handleInput("\r"); await tick(); // danger confirms start on Cancel
    expect(flow.notifications.join("\n")).toMatch(/reset failed/);
    expect(flow.frame()).not.toContain("Really reset Global to defaults?");
  });

  it("delete", async () => {
    const flow = await openEditMode({});
    for (let i = 0; i < 4; i += 1) flow.body.handleInput("\t");
    flow.body.handleInput("\r"); await tick();
    expect(flow.frame()).toContain("Really delete the Global config file?");
    flow.body.handleInput("\x1b[C"); flow.body.handleInput("\r"); await tick(); // danger confirms start on Cancel
    expect(flow.notifications.join("\n")).toMatch(/delete failed/);
    expect(flow.frame()).not.toContain("Really delete the Global config file?");
  });
});
