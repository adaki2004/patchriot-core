/** Wallet code is loaded only in a separate page, after the user asks for it. */
export function openWallet(
  intent: "signin" | "payment",
  orderId?: string,
): Promise<void> {
  if (intent === "payment" && !/^[0-9a-f-]{36}$/i.test(orderId ?? ""))
    return Promise.reject(new Error("This order is unavailable."));
  const request = crypto.randomUUID();
  const fragment = new URLSearchParams({
    intent,
    request,
    ...(orderId ? { order: orderId } : {}),
  });
  const popup = window.open(
    `/wallet#${fragment}`,
    `patchriot-wallet-${request}`,
    "popup,width=520,height=760",
  );
  if (!popup)
    return Promise.reject(
      new Error(
        "Allow the wallet window to open, then try again. Manual transfers are also available.",
      ),
    );
  return new Promise((resolve, reject) => {
    let finished = false;
    const stop = (error?: string) => {
      if (finished) return;
      finished = true;
      window.removeEventListener("message", message);
      clearInterval(poll);
      clearTimeout(timeout);
      if (error) reject(new Error(error));
      else resolve();
    };
    const message = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.source !== popup ||
        event.data?.request !== request ||
        event.data?.kind !== "patchriot-wallet-finished" ||
        event.data?.intent !== intent
      )
        return;
      stop();
      popup.close();
    };
    window.addEventListener("message", message);
    const poll = window.setInterval(() => {
      if (popup.closed)
        stop(
          "The wallet window closed. Check your order before sending another payment.",
        );
    }, 500);
    const timeout = window.setTimeout(
      () =>
        stop(
          "The wallet window timed out. Check your account or order before retrying.",
        ),
      10 * 60_000,
    );
  });
}
