import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api, serverMessage } from "@/lib/http";

type UseLoginOptions = {
  /** 登录接口成功后调用（刷新账户、跳转等）；抛错时错误文字显示在表单里 */
  onSuccess: () => Promise<void> | void;
  /** 非 Error 异常时显示的 i18n key */
  requestFailedKey?: string;
  /** 首次因缺少 2FA 被拦截后聚焦 2FA 输入框 */
  onRequireTwoFactor?: () => void;
};

const TWO_FA_STORAGE_KEY = "komari_has_2fa";

/**
 * 用户名 / 密码 / 2FA 登录表单的状态与 /api/login 提交。
 * 登录页（/admin/login）和受限页面的登录对话框共用。
 * 服务器返回「2FA code is required」时打开 2FA 字段。
 */
export function useLogin({
  onSuccess,
  requestFailedKey = "login.request_failed",
  onRequireTwoFactor,
}: UseLoginOptions) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [twoFactor, setTwoFactor] = useState("");
  const [requireTwoFactor, setRequireTwoFactor] = useState(() => {
    try {
      return localStorage.getItem(TWO_FA_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const login = async () => {
    setBusy(true);
    setError("");
    try {
      const trimmedTwoFactor = twoFactor.trim();
      try {
        // 登录接口只看 HTTP 状态，不检查响应体的 status 字段
        await api.post(
          "/api/login",
          {
            username,
            password,
            ...(trimmedTwoFactor ? { "2fa_code": trimmedTwoFactor } : {}),
          },
          { expectSuccess: false },
        );
      } catch (requestError) {
        if (requestError instanceof ApiError) {
          const message = serverMessage(requestError);
          if (message === "2FA code is required") {
            setRequireTwoFactor(true);
            try {
              localStorage.setItem(TWO_FA_STORAGE_KEY, "true");
            } catch {}
            onRequireTwoFactor?.();
          }
          throw new Error(message || `HTTP ${requestError.status}`);
        }
        throw requestError;
      }
      if (trimmedTwoFactor) {
        try {
          localStorage.setItem(TWO_FA_STORAGE_KEY, "true");
        } catch {}
      }
      await onSuccess();
    } catch (loginError) {
      setError(
        loginError instanceof Error
          ? loginError.message
          : t(requestFailedKey),
      );
    } finally {
      setBusy(false);
    }
  };

  return {
    username,
    setUsername,
    password,
    setPassword,
    twoFactor,
    setTwoFactor,
    requireTwoFactor,
    error,
    busy,
    login,
  };
}
