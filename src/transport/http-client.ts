import type { InvokeRequest, InvokeResponse, StatusResponse, ResultResponse, DescribeResponse } from "./types.ts";

export async function invoke(baseUrl: string, request: InvokeRequest, traceparent?: string | null): Promise<InvokeResponse> {
  const url = `${baseUrl.replace(/\/+$/, "")}/invoke`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(traceparent ? { traceparent } : {}) },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`POST ${url} returned ${res.status}: ${body}`);
  }
  return res.json() as Promise<InvokeResponse>;
}

export async function getStatus(baseUrl: string, runId: string): Promise<StatusResponse> {
  const url = `${baseUrl.replace(/\/+$/, "")}/status/${encodeURIComponent(runId)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${url} returned ${res.status}: ${body}`);
  }
  return res.json() as Promise<StatusResponse>;
}

export async function describe(baseUrl: string): Promise<DescribeResponse> {
  const url = `${baseUrl.replace(/\/+$/, "")}/describe`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${url} returned ${res.status}: ${body}`);
  }
  return res.json() as Promise<DescribeResponse>;
}

export async function cancelRun(baseUrl: string, runId: string): Promise<{ runId: string; state: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/cancel/${encodeURIComponent(runId)}`;
  const res = await fetch(url, { method: "POST" });
  if (res.status === 404) throw new Error(`Run ${runId} not found`);
  if (res.status === 409) {
    const body = await res.json().catch(() => ({})) as { state?: string };
    throw new Error(`Run ${runId} already finished (${body.state || "unknown"})`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`POST ${url} returned ${res.status}: ${body}`);
  }
  return res.json() as Promise<{ runId: string; state: string }>;
}

export async function getResult(baseUrl: string, runId: string): Promise<ResultResponse> {
  const url = `${baseUrl.replace(/\/+$/, "")}/result/${encodeURIComponent(runId)}`;
  const res = await fetch(url);
  if (res.status === 409) throw new Error(`Run ${runId} still in progress`);
  if (res.status === 404) throw new Error(`Run ${runId} not found`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${url} returned ${res.status}: ${body}`);
  }
  return res.json() as Promise<ResultResponse>;
}
