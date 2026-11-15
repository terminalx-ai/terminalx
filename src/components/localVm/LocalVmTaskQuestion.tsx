import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { LocalVmQuestion } from "@/lib/localVm";
import { localVmFieldClass } from "./fields";

/**
 * A question the guest worker asked, answered from its task card (review 2):
 * a choice of its options, or several where it allows that, and text of the
 * reader's own where it asks for that or offers no options.
 */
export function LocalVmTaskQuestion({ question, disabled, onAnswer }: {
  question: LocalVmQuestion; disabled: boolean; onAnswer: (answers: Record<string, string>) => void;
}) {
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [written, setWritten] = useState<Record<string, string>>({});
  const answers = Object.fromEntries(question.questions.map((item) => {
    const own = written[item.question]?.trim();
    return [item.question, [...(chosen[item.question] ?? []), ...(own ? [own] : [])].join(", ")];
  }));
  const complete = question.questions.every((item) => answers[item.question]);
  function choose(item: LocalVmQuestion["questions"][number], option: string, on: boolean) {
    setChosen((current) => {
      const prior = current[item.question] ?? [];
      const next = item.multiSelect ? (on ? [...prior, option] : prior.filter((value) => value !== option)) : [option];
      return { ...current, [item.question]: next };
    });
  }
  return <section aria-label="Guest question" className="space-y-2 rounded border border-warning/50 p-2">
    {question.questions.map((item, index) => <fieldset key={item.question} className="space-y-1">
      <legend className="font-medium">{item.header ? `${item.header}: ` : ""}{item.question}</legend>
      {item.options.map((option) => <label key={option} className="flex items-center gap-2">
        <input type={item.multiSelect ? "checkbox" : "radio"} name={`${question.requestId}-${index}`} disabled={disabled}
          checked={(chosen[item.question] ?? []).includes(option)} onChange={(event) => choose(item, option, event.target.checked)} />
        {option}
      </label>)}
      {item.freeText ? <label className="block space-y-1"><span>{item.options.length ? "Or your own answer" : "Your answer"}</span>
        <input className={localVmFieldClass} disabled={disabled} value={written[item.question] ?? ""} maxLength={16 * 1024}
          onChange={(event) => setWritten((current) => ({ ...current, [item.question]: event.target.value }))} />
      </label> : null}
    </fieldset>)}
    <Button size="xs" variant="outline" disabled={disabled || !complete} onClick={() => onAnswer(answers)}>Send answers</Button>
  </section>;
}
