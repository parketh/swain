import { Box, Text, useInput } from "ink"
import { useState } from "react"

export interface QuestionPromptOption {
  readonly label: string
  readonly description: string
}

export interface QuestionPromptQuestion {
  readonly question: string
  readonly options: ReadonlyArray<QuestionPromptOption>
  readonly multiSelect?: boolean
}

export interface QuestionPromptAnswer {
  readonly question: string
  readonly selected: ReadonlyArray<string>
}

export interface QuestionPromptProps {
  readonly questions: ReadonlyArray<QuestionPromptQuestion>
  readonly onSubmit: (answers: ReadonlyArray<QuestionPromptAnswer>) => void
}

/**
 * Structured multi-question prompt for the core `Ask` tool. Left/Right moves
 * between questions and a final submit step; Up/Down moves options; Enter
 * selects (single) or toggles (multi). Submit only fires from the submit step
 * once every question has an answer.
 */
export const QuestionPrompt = ({ questions, onSubmit }: QuestionPromptProps) => {
  const submitStep = questions.length
  const [active, setActive] = useState(0)
  const [option, setOption] = useState(0)
  const [answers, setAnswers] = useState<ReadonlyArray<ReadonlyArray<string>>>(
    questions.map(() => []),
  )

  const onSubmitStep = active === submitStep
  const current = questions[active]
  const allAnswered = answers.every((a) => a.length > 0)

  useInput((_input, key) => {
    if (key.leftArrow) {
      setActive((a) => Math.max(0, a - 1))
      setOption(0)
      return
    }
    if (key.rightArrow) {
      setActive((a) => Math.min(submitStep, a + 1))
      setOption(0)
      return
    }
    if (onSubmitStep) {
      if (key.return && allAnswered) {
        onSubmit(questions.map((q, i) => ({ question: q.question, selected: answers[i] ?? [] })))
      }
      return
    }
    if (current === undefined) return
    if (key.upArrow) return setOption((o) => Math.max(0, o - 1))
    if (key.downArrow) return setOption((o) => Math.min(current.options.length - 1, o + 1))
    if (key.return) {
      const label = current.options[option]?.label
      if (label === undefined) return
      setAnswers((prev) => {
        const next = prev.map((a) => [...a])
        if (current.multiSelect === true) {
          const set = new Set(next[active])
          if (set.has(label)) set.delete(label)
          else set.add(label)
          next[active] = [...set]
        } else {
          next[active] = [label]
        }
        return next
      })
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box>
        {questions.map((q, i) => (
          <Text key={q.question} color={i === active ? "cyan" : undefined}>
            {`[${(answers[i]?.length ?? 0) > 0 ? "x" : " "}${i + 1}] `}
          </Text>
        ))}
        <Text color={onSubmitStep ? "cyan" : undefined}>[submit]</Text>
      </Box>
      {onSubmitStep ? (
        <Text color={allAnswered ? "green" : "yellow"}>
          {allAnswered ? "Press Enter to submit" : "Answer every question first"}
        </Text>
      ) : current !== undefined ? (
        <Box flexDirection="column">
          <Text bold>{current.question}</Text>
          {current.options.map((opt, i) => {
            const chosen = (answers[active] ?? []).includes(opt.label)
            return (
              <Text key={opt.label} color={i === option ? "cyan" : undefined}>
                {i === option ? "› " : "  "}
                {chosen ? "◉ " : "◯ "}
                {opt.label} — {opt.description}
              </Text>
            )
          })}
        </Box>
      ) : null}
    </Box>
  )
}
