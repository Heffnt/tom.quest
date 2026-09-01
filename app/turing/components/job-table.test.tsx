// Regression guard for job cancellation in the jobs table.
//
// Cancel-all used to hand-roll its own fetch instead of going through the
// shared /api/turing request helper, so a failed Cancel-all printed the raw
// response body — unparsed and untruncated — into the confirm dialog, while a
// failed single cancel showed the helper's parsed, 120-character message.
// These tests pin both buttons to the helper's message.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import JobTable from "./job-table";
import type { Job } from "../types";

vi.mock("@/app/lib/auth", () => ({
  useAuth: () => ({ token: "test-token" }),
}));

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const LONG_REASON = "scancel refused: ".padEnd(400, "x");

function makeJob(jobId: string): Job {
  return {
    job_id: jobId,
    screen_name: null,
    gpu_type: "a100",
    status: "RUNNING",
    time_remaining: "1:00:00",
    gpu_stats: null,
  } as unknown as Job;
}

const jobs = [makeJob("101"), makeJob("102")];

function failingFetch(body: string, contentType: string) {
  return vi.fn<FetchLike>(async () =>
    new Response(body, { status: 502, headers: { "Content-Type": contentType } }),
  );
}

/** The confirm dialog's button repeats the "Cancel all" label, so scope to it. */
function confirmCancelAll() {
  const dialog = screen.getByRole("dialog", { name: /Cancel all/ });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel all" }));
}

function renderTable() {
  return render(
    <JobTable data={jobs} loading={false} error={null} isTom onRefresh={() => {}} />,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("JobTable cancellation", () => {
  it("shows the parsed, truncated error when Cancel all fails", async () => {
    const fetchMock = failingFetch(JSON.stringify({ error: LONG_REASON }), "application/json");
    vi.stubGlobal("fetch", fetchMock);

    renderTable();
    fireEvent.click(screen.getByRole("button", { name: "Cancel all" }));
    confirmCancelAll();

    const shown = await screen.findByText(/^scancel refused: /);
    expect(shown.textContent).toBe(`${LONG_REASON.slice(0, 119)}…`);
    expect(shown.textContent).not.toContain("{\"error\"");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/turing/jobs/101");
  });

  it("shows the same message when a single cancel fails", async () => {
    const fetchMock = failingFetch(JSON.stringify({ error: LONG_REASON }), "application/json");
    vi.stubGlobal("fetch", fetchMock);

    renderTable();
    fireEvent.click(screen.getByRole("button", { name: "Cancel job 101" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel job" }));

    const shown = await screen.findByText(/^scancel refused: /);
    expect(shown.textContent).toBe(`${LONG_REASON.slice(0, 119)}…`);
  });

  it("stops Cancel all at the first failure", async () => {
    const fetchMock = failingFetch(JSON.stringify({ error: "nope" }), "application/json");
    vi.stubGlobal("fetch", fetchMock);

    renderTable();
    fireEvent.click(screen.getByRole("button", { name: "Cancel all" }));
    confirmCancelAll();

    await screen.findByText("nope");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels every job in order and closes the dialog on success", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderTable();
    fireEvent.click(screen.getByRole("button", { name: "Cancel all" }));
    confirmCancelAll();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      "/api/turing/jobs/101",
      "/api/turing/jobs/102",
    ]);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Cancel all/ })).toBeNull(),
    );
  });
});
