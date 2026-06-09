import { useCallback, useEffect, useRef, useState } from "react";

interface AppNotificationOptions {
  title: string;
  body: string;
  tag?: string; // 같은 tag면 기존 알림 대체 (복수 알림 방지)
  icon?: string;
  badge?: string;
  sound?: boolean; // 소리 재생 여부
  vibrate?: boolean; // 진동 여부 (모바일)
}

const PUSH_SUBSCRIBE_URL = import.meta.env.VITE_PUSH_SUBSCRIBE_URL || "";
const PUSH_PUBLIC_KEY_URL = import.meta.env.VITE_PUSH_PUBLIC_KEY_URL || "http://localhost:8000/push/public_key";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export const useNotification = () => {
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof window !== "undefined" && "Notification" in window
      ? Notification.permission
      : "default",
  );
  const [pushSubscription, setPushSubscription] = useState<PushSubscription | null>(
    null,
  );
  const [pushSupported, setPushSupported] = useState(false);
  const permissionRef = useRef<NotificationPermission | null>(null);
  const swRegistrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const lastNotificationTimeRef = useRef<number>(0);

  // 1️⃣ 알림 권한 요청
  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!("Notification" in window)) {
      console.warn("이 브라우저는 알림을 지원하지 않습니다.");
      return false;
    }

    if (Notification.permission === "granted") {
      permissionRef.current = "granted";
      setPermission("granted");
      return true;
    }

    if (Notification.permission === "denied") {
      console.warn("알림 권한이 거부되었습니다.");
      setPermission("denied");
      return false;
    }

    try {
      const grantedPermission = await Notification.requestPermission();
      permissionRef.current = grantedPermission;
      setPermission(grantedPermission);
      return grantedPermission === "granted";
    } catch (err) {
      console.error("알림 권한 요청 중 오류:", err);
      return false;
    }
  }, []);

  const registerServiceWorker = useCallback(async (): Promise<ServiceWorkerRegistration | null> => {
    if (!("serviceWorker" in navigator)) return null;

    try {
      const registration = await navigator.serviceWorker.register("/sw.js");
      swRegistrationRef.current = registration;
      return registration;
    } catch (err) {
      console.warn("Service Worker 등록 실패:", err);
      return null;
    }
  }, []);

  const ensureServiceWorker = useCallback(async () => {
    if (swRegistrationRef.current) return swRegistrationRef.current;
    return await registerServiceWorker();
  }, [registerServiceWorker]);

  const sendSubscriptionToServer = useCallback(
    async (subscription: PushSubscription) => {
      if (!PUSH_SUBSCRIBE_URL) {
        console.info(
          "Push subscription ready. Set VITE_PUSH_SUBSCRIBE_URL to send it to your server.",
          subscription,
        );
        return;
      }

      try {
        await fetch(PUSH_SUBSCRIBE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(subscription),
        });
      } catch (err) {
        console.warn("푸시 구독 정보 전송 실패:", err);
      }
    },
    [],
  );

  const subscribePush = useCallback(async (): Promise<PushSubscription | null> => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      console.warn("이 브라우저는 푸시를 지원하지 않습니다.");
      return null;
    }

    const granted = await requestPermission();
    if (!granted) return null;

    const registration = await ensureServiceWorker();
    if (!registration) return null;

    try {
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        setPushSubscription(existing);
        return existing;
      }

      // 백엔드에서 공개 키 동적으로 받기
      let vapidPublicKey: string;
      try {
        const response = await fetch(PUSH_PUBLIC_KEY_URL);
        if (!response.ok) throw new Error("공개 키 조회 실패");
        const data = await response.json();
        vapidPublicKey = data.vapidPublicKey;
      } catch (err) {
        console.error("공개 키 조회 실패:", err);
        return null;
      }

      if (!vapidPublicKey) {
        console.warn("VAPID 공개 키를 받지 못했습니다.");
        return null;
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
      setPushSubscription(subscription);
      await sendSubscriptionToServer(subscription);
      return subscription;
    } catch (err) {
      console.warn("푸시 구독 실패:", err);
      return null;
    }
  }, [ensureServiceWorker, requestPermission, sendSubscriptionToServer]);

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
      const audioContext = new (
        window.AudioContext || (window as any).webkitAudioContext
      )();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

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
      navigator.vibrate([200, 100, 200]);
    }
  }, []);

  // 5️⃣ 알림 전송
  const notify = useCallback(
    async (options: AppNotificationOptions): Promise<void> => {
      if (!("Notification" in window)) {
        console.warn("이 브라우저는 알림을 지원하지 않습니다.");
        return;
      }

      if (Notification.permission !== "granted") {
        const hasPermission = await requestPermission();
        if (!hasPermission) return;
      }

      if (!canSendNotification(options.tag)) return;

      const notificationPayload = {
        body: options.body,
        tag: options.tag || "default",
        icon: options.icon,
        badge: options.badge,
        requireInteraction: true,
        silent: !options.sound,
      } as any;

      try {
        const useServiceWorker =
          swRegistrationRef.current !== null &&
          document.visibilityState !== "visible";

        if (useServiceWorker) {
          const notificationOptions = {
            ...notificationPayload,
            vibrate: options.vibrate ? [200, 100, 200] : undefined,
          } as any;
          swRegistrationRef.current?.showNotification(
            options.title,
            notificationOptions,
          );
        } else {
          const notification = new Notification(options.title, notificationPayload);
          notification.onclick = () => {
            window.focus();
            notification.close();
          };
        }

        if (options.sound) playAlertSound();
        if (options.vibrate) vibrate();
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

  useEffect(() => {
    setPushSupported(
      typeof window !== "undefined" &&
        "serviceWorker" in navigator &&
        "PushManager" in window &&
        "Notification" in window,
    );

    if ("Notification" in window) {
      permissionRef.current = Notification.permission;
      setPermission(Notification.permission);
    }
    registerServiceWorker();
  }, [registerServiceWorker]);

  return {
    requestPermission,
    notify,
    notifyDanger,
    subscribePush,
    hasPermission: permission === "granted",
    hasPushSupport: pushSupported,
    pushSubscription,
  };
};
