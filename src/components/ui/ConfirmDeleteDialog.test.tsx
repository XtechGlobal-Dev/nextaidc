import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";

const PHRASE = "delete web service AgentLabs-AI-Dev-1";

function setup(overrides: Partial<Parameters<typeof ConfirmDeleteDialog>[0]> = {}) {
  const onConfirm = overrides.onConfirm ?? vi.fn().mockResolvedValue(undefined);
  const onOpenChange = overrides.onOpenChange ?? vi.fn();
  render(
    <ConfirmDeleteDialog
      open
      onOpenChange={onOpenChange}
      resourceType="web service"
      resourceName="AgentLabs-AI-Dev-1"
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  const deleteBtn = () => screen.getByRole("button", { name: "Delete" });
  const cancelBtn = () => screen.getByRole("button", { name: "Cancel" });
  const input = () => screen.getByRole("textbox");
  return { onConfirm, onOpenChange, deleteBtn, cancelBtn, input };
}

describe("ConfirmDeleteDialog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps Delete disabled until the exact phrase is typed", async () => {
    const user = userEvent.setup();
    const { deleteBtn, input } = setup();

    expect(deleteBtn()).toBeDisabled();

    await user.type(input(), "delete web service Agent"); // partial
    expect(deleteBtn()).toBeDisabled();

    await user.type(input(), "Labs-AI-Dev-1"); // now complete
    expect(input()).toHaveValue(PHRASE);
    expect(deleteBtn()).toBeEnabled();
  });

  it("keeps Delete disabled for incorrect input (wrong case)", async () => {
    const user = userEvent.setup();
    const { deleteBtn, input } = setup();

    await user.type(input(), "Delete web service AgentLabs-AI-Dev-1"); // capital D
    expect(input()).toHaveValue("Delete web service AgentLabs-AI-Dev-1");
    expect(deleteBtn()).toBeDisabled();
  });

  it("runs the delete action and closes on the correct phrase", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    const { deleteBtn, input } = setup({ onConfirm, onOpenChange });

    await user.type(input(), PHRASE);
    await user.click(deleteBtn());

    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("Cancel closes the dialog without deleting", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    const { cancelBtn, input } = setup({ onConfirm, onOpenChange });

    // Even with a valid phrase typed, Cancel must not trigger the delete.
    await user.type(input(), PHRASE);
    await user.click(cancelBtn());

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("surfaces an error and stays open when the delete fails", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockRejectedValue(new Error("Server said no"));
    const onOpenChange = vi.fn();
    const { deleteBtn, input } = setup({ onConfirm, onOpenChange });

    await user.type(input(), PHRASE);
    await user.click(deleteBtn());

    expect(await screen.findByText("Server said no")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
