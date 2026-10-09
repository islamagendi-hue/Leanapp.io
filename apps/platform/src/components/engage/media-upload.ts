/**
 * Browser upload with progress (fetch has no upload progress, XMLHttpRequest
 * does). Sends the session cookie to this origin only; the server checks the
 * Origin and the member's rights.
 */
export interface UploadResponse {
  status: number;
  body: Record<string, unknown> | null;
}

export function postWithProgress(url: string, form: FormData, onProgress: (fraction: number) => void): Promise<UploadResponse> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => resolve({ status: xhr.status, body: (xhr.response as Record<string, unknown> | null) ?? null });
    xhr.onerror = () => resolve({ status: 0, body: null });
    xhr.ontimeout = () => resolve({ status: 0, body: null });
    xhr.timeout = 120_000;
    xhr.send(form);
  });
}

/** Library base path of the current project page (/o/{org}/apps/{app}), from the address. */
export function projectBase(pathname: string): string | null {
  const m = /^\/o\/([^/]+)\/apps\/([^/]+)/.exec(pathname);
  return m ? `/o/${m[1]}/apps/${m[2]}` : null;
}

export const fmtBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
