import { describe, it, expect, vi, afterEach } from "vitest";
import { info, error, setQuiet } from "./logger.js";

describe("logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // Reset module-level quiet state so it never leaks between tests.
    setQuiet(false);
  });

  it("info writes a line matching /INFO hi/ to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    info("hi");
    expect(spy).toHaveBeenCalledOnce();
    const line = spy.mock.calls[0]![0] as string;
    expect(line).toMatch(/INFO hi\n$/);
  });

  it("info includes JSON-stringified meta", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    info("hi", { x: 1 });
    expect(spy).toHaveBeenCalledOnce();
    const line = spy.mock.calls[0]![0] as string;
    expect(line).toMatch(/INFO hi {"x":1}\n$/);
  });

  it("error writes a line matching /ERROR boom/ to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    error("boom", { code: 42 });
    expect(spy).toHaveBeenCalledOnce();
    const line = spy.mock.calls[0]![0] as string;
    expect(line).toMatch(/ERROR boom {"code":42}\n$/);
  });

  it("setQuiet(true) silences info but never gates error", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setQuiet(true);

    info("hidden");
    expect(spy).not.toHaveBeenCalled();

    error("still shown");
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0] as string).toMatch(/ERROR still shown\n$/);
  });

  it("setQuiet(false) restores info output", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setQuiet(true);
    setQuiet(false);
    info("back");
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0] as string).toMatch(/INFO back\n$/);
  });
});
