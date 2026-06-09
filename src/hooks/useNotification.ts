import { useCallback, useEffect, useRef } from "react";

interface NotificationOptions {
  title: string;
  body: string;
  tag?: string; // 같은 tag면 기존 알림 대체 (복수 알림 방지)
  icon?: string;
  badge?: string;
  sound?: boolean; // 소리 재생 여부
  vibrate?: boolean; // 진동 여부 (모바일)
}

export const useNotification = () => {
  const permissionRef = useRef<NotificationPermission | null>(null);
  const lastNotificationTimeRef = useRef<number>(0);

  // 1️⃣ 알림 권한 요청
  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!("Notification" in window)) {
      console.warn("이 브라우저는 알림을 지원하지 않습니다.");
      return false;
    }

    if (Notification.permission === "granted") {
      permissionRef.current = "granted";
      return true;
    }

    if (Notification.permission === "denied") {
      console.warn("알림 권한이 거부되었습니다.");
      return false;
    }

    // 권한 요청
    try {
      const permission = await Notification.requestPermission();
      permissionRef.current = permission;
      return permission === "granted";
    } catch (err) {
      console.error("알림 권한 요청 중 오류:", err);
      return false;
    }
  }, []);

  // 2️⃣ 알림 중복 방지 (debounce - 2초 이내 같은 tag 알림 무시)
  const canSendNotification = useCallback((tag?: string): boolean => {
    const now = Date.now();
    const lastTime = lastNotificationTimeRef.current;
    if (now - lastTime < 2000) return false; // 2초 간격
    lastNotificationTimeRef.current = now;
    return true;
  }, []);

  // 3️⃣ 소리 재생 함수
  const playAlertSound = useCallback(() => {
    try {
      // 브라우저 기본 beep 음성 생성
      const audioContext = new (
        window.AudioContext || (window as any).webkitAudioContext
      )();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      // 경보음 (800Hz, 200ms)
      oscillator.frequency.value = 800;
      oscillator.type = "sine";
      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(
        0.01,
        audioContext.currentTime + 0.2,
      );

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.2);
    } catch (err) {
      console.error("소리 재생 오류:", err);
    }
  }, []);

  // 4️⃣ 진동 함수 (모바일)
  const vibrate = useCallback(() => {
    if ("vibrate" in navigator) {
      navigator.vibrate([200, 100, 200]); // 진동 패턴: 200ms, 100ms 휴식, 200ms
    }
  }, []);

  // 5️⃣ 알림 전송
  const notify = useCallback(
    async (options: NotificationOptions): Promise<void> => {
      // 권한 확인
      if (!permissionRef.current) {
        const hasPermission = await requestPermission();
        if (!hasPermission) return;
      }

      // 중복 알림 방지
      if (!canSendNotification(options.tag)) return;

      try {
        // 브라우저 알림
        const notification = new Notification(options.title, {
          body: options.body,
          tag: options.tag || "default",
          icon: options.icon,
          badge: options.badge,
          requireInteraction: true, // 사용자가 닫을 때까지 유지
          silent: !options.sound,
        });

        // 알림 클릭 시 창 포커스
        notification.onclick = () => {
          window.focus();
          notification.close();
        };

        // 소리 및 진동
        if (options.sound) playAlertSound();
        if (options.vibrate) vibrate();

        // Service Worker 알림 시도 (오프라인 모드)
        if ("serviceWorker" in navigator) {
          const registration = await navigator.serviceWorker.ready;
          registration.showNotification(options.title, {
            body: options.body,
            tag: options.tag || "default",
            icon: options.icon,
            requireInteraction: true,
          });
        }
      } catch (err) {
        console.error("알림 전송 오류:", err);
      }
    },
    [requestPermission, canSendNotification, playAlertSound, vibrate],
  );

  // 6️⃣ 위험도 수준별 알림
  const notifyDanger = useCallback(
    async (
      riskLevel: "warn" | "danger",
      riskScore: number,
      details?: string,
    ) => {
      const isDanger = riskLevel === "danger";
      await notify({
        title: isDanger ? "🚨 위험 감지!" : "⚠️ 경고",
        body: `위험도: ${riskScore.toFixed(0)}%${details ? `\n${details}` : ""}`,
        tag: "motion-alert",
        icon: isDanger
          ? "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='45' fill='%23EF4444'/%3E%3Ctext x='50' y='60' font-size='60' fill='white' text-anchor='middle'%3E!%3C/text%3E%3C/svg%3E"
          : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='45' fill='%23F59E0B'/%3E%3Ctext x='50' y='60' font-size='60' fill='white' text-anchor='middle'%3E?%3C/text%3E%3C/svg%3E",
        sound: true,
        vibrate: true,
      });
    },
    [notify],
  );

  // 초기화: 페이지 로드 시 권한 확인
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "granted") {
      permissionRef.current = "granted";
    }
  }, []);

  return {
    requestPermission,
    notify,
    notifyDanger,
    hasPermission: permissionRef.current === "granted",
  };
};
