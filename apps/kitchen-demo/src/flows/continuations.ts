import { btn, callCC, prompt, redirectCC, send } from "fluxgram";
import type { StepLike } from "fluxgram";
import { backToMenu } from "./shared";

export function continuationsDemo(): StepLike {
  return [
    send("Continuation demo: this body can jump to a saved continuation."),
    callCC("inside-continuation-demo", [
      prompt.buttons("Choose whether to skip the rest of this body.", {
        buttons: [
          btn("Skip body", redirectCC("inside-continuation-demo")),
          btn("Continue body", send("You chose to continue inside the body.")),
        ],
      }),
      send("This line only appears if you chose Continue body."),
    ]),
    send("The saved continuation resumed after callCC."),
    backToMenu(),
  ];
}
