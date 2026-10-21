import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import type { ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button, Text, TextField } from "@radix-ui/themes";
import { ShieldCheck } from "lucide-react";
import {
  DEFAULT_TERMINAL_OPTIONS,
  DEFAULT_TERMINAL_PADDING,
} from "./terminalDefaults";

export interface TerminalSessionApi {
  terminal: Terminal;
  searchAddon: SearchAddon;
  send: (data: string | Uint8Array) => void;
  fit: () => void;
  exportText: () => string;
}

interface TerminalSessionProps {
  uuid: string;
  active: boolean;
  fontSize?: number;
  padding?: number;
  twoFaEnabled: boolean;
  disconnectMessage: string;
  onApiChange: (api: TerminalSessionApi | null) => void;
}

const RECONNECT_INTERVAL = 1000;
// 与 Server/Agent 的会话保留窗口（5 分钟）保持一致，Agent 离线恢复后会话仍可续用。
const RECONNECT_WINDOW = 5 * 60 * 1000;

const encode = (value: string) => new TextEncoder().encode(value);

const normalizePaste = (value: string) => value.replace(/\r?\n/g, "\r");

// 单个终端标签的 xterm、WebSocket 与快捷键会话
const TerminalSession = ({
  uuid,
  active,
  fontSize = DEFAULT_TERMINAL_OPTIONS.fontSize,
  padding = DEFAULT_TERMINAL_PADDING,
  twoFaEnabled,
  disconnectMessage,
  onApiChange,
}: TerminalSessionProps) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  const disconnectMessageRef = useRef(disconnectMessage);
  const onApiChangeRef = useRef(onApiChange);
  const toastId = useId();
  const { t } = useTranslation();

  const [showOtpModal, setShowOtpModal] = useState(twoFaEnabled);
  const [otpValue, setOtpValue] = useState("");
  const [otpError, setOtpError] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const connectWithOtpRef = useRef<((otp: string) => void) | null>(null);
  const otpInputRef = useRef<HTMLInputElement>(null);

  activeRef.current = active;

  useEffect(() => {
    if (active && showOtpModal) {
      const timer = setTimeout(() => {
        otpInputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [active, showOtpModal]);

  useEffect(() => {
    disconnectMessageRef.current = disconnectMessage;
  }, [disconnectMessage]);

  useEffect(() => {
    onApiChangeRef.current = onApiChange;
  }, [onApiChange]);

  useEffect(() => {
    if (!hostRef.current) {
      return;
    }

    const themeWithSelection = {
      selectionBackground: "#ffffff",
      selectionForeground: "#000000",
      selectionInactiveBackground: "#ffffff",
      scrollbarSliderBackground: "#555555",
      scrollbarSliderHoverBackground: "#777777",
      scrollbarSliderActiveBackground: "#888888",
    };

    const terminalOptions: Partial<ITerminalOptions> = {
      ...DEFAULT_TERMINAL_OPTIONS,
      fontSize,
      cursorStyle: "bar",
      cursorInactiveStyle: "bar",
      cursorWidth: 2,
      allowProposedApi: true,
      overviewRuler: { width: 4 },
      theme: themeWithSelection,
    };

    const term = new Terminal(terminalOptions);
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const webLinksAddon = new WebLinksAddon();
    const host = hostRef.current;
    let disposed = false;
    let firstBinary = false;
    let firstBinaryTimeout: ReturnType<typeof setTimeout> | null = null;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let requestID: string | null = null;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stableConnectionTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDeadline: number | null = null;
    let currentOtp: string | null = null;

    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(webLinksAddon);
    term.open(host);

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const baseUrl = `${protocol}//${window.location.host}`;

    const send = (data: string | Uint8Array) => {
      if (disposed || !ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      ws.send(typeof data === "string" ? encode(data) : data);
    };

    const fit = () => {
      if (disposed) {
        return;
      }
      fitAddon.fit();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "resize",
            cols: term.cols,
            rows: term.rows,
          }),
        );
      }
    };

    const exportText = () => {
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (line) {
          lines.push(line.translateToString(true));
        }
      }
      while (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      return lines.join("\n");
    };

    const copySelection = async () => {
      const selectedText = term.getSelection();
      if (!selectedText) {
        return;
      }
      try {
        await navigator.clipboard.writeText(selectedText);
        if (!disposed) {
          term.clearSelection();
          term.focus();
        }
      } catch {
        // Clipboard permissions are reported by the existing HTTPS callout.
      }
    };

    const pasteClipboard = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (disposed) {
          return;
        }
        term.clearSelection();
        term.focus();
        send(normalizePaste(text));
      } catch {
        // Clipboard permissions are reported by the existing HTTPS callout.
      }
    };

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") {
        return true;
      }

      const ctrlOnly =
        event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
      const ctrlAlt =
        event.ctrlKey &&
        event.altKey &&
        !event.metaKey &&
        !event.shiftKey;
      const ctrlShiftV =
        event.ctrlKey &&
        event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        event.key.toLowerCase() === "v";

      if (
        ctrlOnly ||
        ctrlAlt ||
        ctrlShiftV
      ) {
        const key = event.key.toLowerCase();
        if (key === "c") {
          event.preventDefault();
          if (term.hasSelection() || ctrlAlt) {
            void copySelection();
          } else {
            send(new Uint8Array([3]));
          }
          return false;
        }
        if (key === "v") {
          event.preventDefault();
          void pasteClipboard();
          return false;
        }
      }

      // Allow page shortcuts like Ctrl+Alt / Ctrl+Shift+F / Alt+Enter to bubble.
      if (
        (event.ctrlKey && event.altKey) ||
        (event.ctrlKey && event.shiftKey) ||
        (event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          event.key === "Enter")
      ) {
        return false;
      }

      return true;
    });

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (term.hasSelection()) {
        void copySelection();
      } else {
        void pasteClipboard();
      }
    };
    host.addEventListener("contextmenu", handleContextMenu);

    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(host);
    const handleWindowResize = () => fit();
    window.addEventListener("resize", handleWindowResize);

    const startHeartbeat = () => {
      if (heartbeatInterval !== null) {
        clearInterval(heartbeatInterval);
      }
      heartbeatInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "heartbeat",
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }, 10000);
    };

    const stopHeartbeat = () => {
      if (heartbeatInterval !== null) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
    };

    const hideReconnectingToast = () => {
      toast.dismiss(toastId);
    };

    const connect = (otp: string | null) => {
      const params = new URLSearchParams();
      // 2FA is required only for the initial session creation. Reattach is
      // authorized by the server-side session owner and must not reuse an
      // expired TOTP value.
      if (otp && !requestID) {
        params.set("2fa_code", otp);
      }
      if (requestID) {
        params.set("request_id", requestID);
      }
      const query = params.toString();
      const socket = new WebSocket(
        `${baseUrl}/api/admin/client/${uuid}/terminal${query ? `?${query}` : ""}`,
      );
      ws = socket;
      socket.binaryType = "arraybuffer";

      socket.onopen = () => {
        if (disposed || ws !== socket) return;
        reconnectTimer = null;
        if (stableConnectionTimer !== null) {
          clearTimeout(stableConnectionTimer);
        }
        // Keep a reconnect window across short-lived flaps. Once the
        // connection is stable, a future outage gets a fresh window.
        stableConnectionTimer = setTimeout(() => {
          reconnectDeadline = null;
          stableConnectionTimer = null;
        }, 10000);
        hideReconnectingToast();
        setShowOtpModal(false);
        setIsConnecting(false);
        setOtpError("");
        fit();
        startHeartbeat();
      };

      socket.onmessage = (event) => {
        if (disposed || ws !== socket) {
          return;
        }
        if (typeof event.data === "string") {
          try {
            const control = JSON.parse(event.data);
            if (
              control &&
              typeof control === "object" &&
              typeof control.request_id === "string"
            ) {
              requestID = control.request_id;
              return;
            }
          } catch {
            // Plain text is terminal output from the server.
          }
        }
        if (event.data instanceof ArrayBuffer) {
          if (!firstBinary) {
            firstBinary = true;
            // Clear screen when first agent binary packet arrives
            term.clear();
            term.write(new Uint8Array(event.data));
            firstBinaryTimeout = setTimeout(() => {
              if (disposed) {
                return;
              }
              term.resize(Math.max(1, term.cols - 1), term.rows);
              fit();
            }, 200);
          } else {
            term.write(new Uint8Array(event.data));
          }
        } else {
          term.write(event.data);
        }
      };

      socket.onclose = () => {
        if (ws !== socket) return;
        ws = null;
        stopHeartbeat();
        if (stableConnectionTimer !== null) {
          clearTimeout(stableConnectionTimer);
          stableConnectionTimer = null;
        }
        if (disposed) {
          return;
        }
        if (!requestID) {
          if (twoFaEnabled) {
            hideReconnectingToast();
            setIsConnecting(false);
            setOtpError(t("terminal.otp_invalid", "2FA 验证码无效或已过期"));
            setShowOtpModal(true);
            setOtpValue("");
            setTimeout(() => {
              otpInputRef.current?.focus();
            }, 50);
          } else {
            scheduleReconnect();
          }
          return;
        }
        scheduleReconnect();
      };

      socket.onerror = () => {};
    };

    const scheduleReconnect = () => {
      const now = Date.now();
      if (reconnectDeadline === null) {
        reconnectDeadline = now + RECONNECT_WINDOW;
      }
      if (now >= reconnectDeadline) {
        hideReconnectingToast();
        term.write(`\n ${disconnectMessageRef.current}`);
        return;
      }
      if (reconnectTimer !== null) return;
      toast.loading(
        t("terminal.reconnecting", "连接已断开，正在尝试重新连接"),
        {
          duration: Infinity,
          id: toastId,
        },
      );
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        // Reuse the verified code while reattaching the existing request.
        // A fresh OTP prompt is shown when the initial authenticated connect
        // fails before a request ID is issued.
        connect(twoFaEnabled ? currentOtp : null);
      }, RECONNECT_INTERVAL);
    };

    connectWithOtpRef.current = (otp: string) => {
      currentOtp = otp;
      connect(otp);
    };

    if (twoFaEnabled) {
      setShowOtpModal(true);
    } else {
      connect(null);
    }

    const termDataDisposable = term.onData((data) => {
      send(data);
    });
    const api: TerminalSessionApi = {
      terminal: term,
      searchAddon,
      send,
      fit,
      exportText,
    };
    onApiChangeRef.current(api);
    requestAnimationFrame(() => {
      fit();
      if (activeRef.current) {
        term.focus();
      }
    });

    return () => {
      disposed = true;
      connectWithOtpRef.current = null;
      onApiChangeRef.current(null);
      host.removeEventListener("contextmenu", handleContextMenu);
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleWindowResize);
      termDataDisposable.dispose();
      if (firstBinaryTimeout !== null) {
        clearTimeout(firstBinaryTimeout);
      }
      stopHeartbeat();
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }
      if (stableConnectionTimer !== null) {
        clearTimeout(stableConnectionTimer);
      }
      hideReconnectingToast();
      if (ws) {
        const socket = ws;
        ws = null;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "close", request_id: requestID }));
        }
        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        ) {
          socket.close();
        }
      }
      term.dispose();
    };
  }, [fontSize, twoFaEnabled, toastId, t, uuid]);

  const style = {
    "--xterm-padding": `${padding}px`,
  } as CSSProperties;

  return (
    <div
      className={`km-terminal-session terminal-page terminal-xterm-host absolute inset-0 h-full w-full overflow-hidden box-border bg-[var(--xterm-container-bg,#000)] p-[var(--xterm-padding,16px)] transition-opacity duration-150 [&_.xterm-viewport]:[scrollbar-width:thin] [&_.xterm-viewport]:[scrollbar-color:var(--xterm-scrollbar-thumb,#555)_var(--xterm-scrollbar-track,#000000)] [&_.xterm-viewport::-webkit-scrollbar]:h-2.5 [&_.xterm-viewport]:[scrollbar-width:thin] [&_.xterm-viewport::-webkit-scrollbar]:w-2.5 [&_.xterm-viewport::-webkit-scrollbar-track]:bg-[var(--xterm-scrollbar-track,#000000)] [&_.xterm-viewport::-webkit-scrollbar-thumb]:rounded-[5px] [&_.xterm-viewport::-webkit-scrollbar-thumb]:bg-[var(--xterm-scrollbar-thumb,#555)] [&_.xterm-viewport::-webkit-scrollbar-thumb:hover]:bg-[var(--xterm-scrollbar-thumb-hover,#777)] ${
        active
          ? "is-active z-[1] visible pointer-events-auto opacity-100"
          : "invisible pointer-events-none opacity-0"
      }`}
      style={style}
      aria-hidden={!active}
    >
      <div
        ref={hostRef}
        className="km-terminal-xterm-viewport h-full min-h-0 w-full overflow-hidden"
      />
      {showOtpModal && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4">
          <div className="w-full max-w-sm rounded-xl border border-neutral-800 bg-[#161616] p-6 shadow-2xl text-neutral-100">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const code = otpValue.trim();
                if (!code || isConnecting) return;
                setIsConnecting(true);
                setOtpError("");
                connectWithOtpRef.current?.(code);
              }}
              className="flex flex-col gap-4"
            >
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-blue-500" />
                <span className="font-semibold text-base">
                  {t("terminal.2fa_prompt", "两步验证 (2FA)")}
                </span>
              </div>
              <Text size="2" className="text-neutral-400">
                {t("terminal.2fa_code_prompt", "请输入 2FA 验证码:")}
              </Text>
              <div className="flex flex-col gap-1.5">
                <TextField.Root
                  ref={otpInputRef}
                  id={`terminal-totp-${uuid}`}
                  name="totp"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  placeholder="000000"
                  maxLength={8}
                  autoFocus
                  value={otpValue}
                  onChange={(e) => {
                    setOtpValue(e.target.value);
                    if (otpError) setOtpError("");
                  }}
                  disabled={isConnecting}
                  className="text-center font-mono text-lg tracking-widest"
                />
                {otpError && (
                  <span className="text-xs text-red-400">{otpError}</span>
                )}
              </div>
              <div className="flex justify-end gap-2 mt-1">
                <Button
                  type="submit"
                  disabled={isConnecting || !otpValue.trim()}
                  className="w-full"
                >
                  {isConnecting ? (
                    <>
                      <div className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-current border-t-transparent mr-1" />
                      {t("terminal.tabs.connecting", "正在连接...")}
                    </>
                  ) : (
                    t("common.confirm", "确认并连接")
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default TerminalSession;
