import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { InfoTip } from "../../src/components/InfoTip";

describe("InfoTip", () => {
  it("shows the text on hover and hides it again", async () => {
    const user = userEvent.setup();
    render(<InfoTip text="explanation" />);
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.hover(screen.getByRole("button"));
    expect(screen.getByRole("tooltip").textContent).toBe("explanation");
    await user.unhover(screen.getByRole("button"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("toggles on click and closes with Escape", async () => {
    const user = userEvent.setup();
    render(<InfoTip text="explanation" />);
    await user.click(screen.getByRole("button"));
    await user.unhover(screen.getByRole("button"));
    expect(screen.getByRole("tooltip")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
