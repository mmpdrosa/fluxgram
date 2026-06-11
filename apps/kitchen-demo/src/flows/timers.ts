import { humanSleep, send, sleep, waitFor } from "fluxgram";
import type { StepLike } from "fluxgram";
import { backToMenu } from "./shared";

export function timersDemo(): StepLike {
  return [
    send("Timer demo: first a short sleep."),
    sleep(1),
    send("Short sleep finished."),
    send("Now a humanSleep with jitter around one second."),
    humanSleep(1),
    send("Humanized sleep finished."),
    send("Now waitFor will poll a condition that never becomes true, then time out."),
    waitFor(() => false, {
      everySecs: 2,
      timeoutSecs: 5,
      onTimeout: send("waitFor timed out and ran its timeout step."),
    }),
    backToMenu(),
  ];
}
