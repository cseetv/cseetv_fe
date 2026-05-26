/* REST API 호출 래퍼 */

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!res.ok) throw new Error(`API 오류: ${res.status}`);
  return res.json();
}

export function useApi() {
  const uploadVideo = async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${API_URL}/api/upload`, { method: "POST", body: form });
    if (!res.ok) throw new Error("업로드 실패");
    return res.json();
  };

  const getSettings = () => request("/api/settings");

  const updateSettings = (settings: Record<string, unknown>) =>
    request("/api/settings", { method: "POST", body: JSON.stringify(settings) });

  const getMetrics = (videoId: string) => request(`/api/metrics/${videoId}`);

  const getAlerts = () => request("/api/alerts");

  const clearAlerts = () => request("/api/alerts/clear", { method: "POST" });

  const checkHealth = () => request("/health");

  return { uploadVideo, getSettings, updateSettings, getMetrics, getAlerts, clearAlerts, checkHealth };
}
