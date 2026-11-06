import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { QuestionField } from '../../../src/shared/question-form'
import { font, space, usePalette, weight } from '../theme'
import { Button, Input } from '../ui'

type Values = Record<string, string | string[]>

function filled(field: QuestionField, value: string | string[] | undefined): boolean {
  return Array.isArray(value) ? value.length > 0 : !!value?.trim()
}

function hintOf(field: QuestionField): string | undefined {
  if (field.placeholder) return field.placeholder
  if (field.kind === 'date') return 'YYYY-MM-DD'
  if (field.kind === 'number' || field.kind === 'range') {
    if (field.min !== undefined && field.max !== undefined) return `${field.min} – ${field.max}`
    return '数字'
  }
  return undefined
}

export function QuestionForm({ fields, busy, onSubmit, onSkip }: { fields: QuestionField[]; busy: boolean; onSubmit: (json: string) => void; onSkip: () => void }) {
  const p = usePalette()
  const [values, setValues] = useState<Values>({})
  const set = (name: string, value: string | string[]) => setValues((current) => ({ ...current, [name]: value }))
  const ready = fields.every((field) => field.optional || filled(field, values[field.name]))
  const submit = () => {
    const out: Record<string, string | string[] | number> = {}
    for (const field of fields) {
      const value = values[field.name]
      if (!filled(field, value)) continue
      if (Array.isArray(value)) out[field.name] = value
      else if (field.kind === 'number' || field.kind === 'range') out[field.name] = Number(value.trim())
      else out[field.name] = value.trim()
    }
    onSubmit(JSON.stringify(out))
  }
  return (
    <View style={styles.form}>
      {fields.map((field) => {
        const value = values[field.name]
        const picked = Array.isArray(value) ? value : value ? [value] : []
        return (
          <View key={field.name} style={styles.field}>
            <Text style={[styles.label, { color: p.fg }]}>
              {field.label}
              {field.optional ? <Text style={{ color: p.fgMute }}>（可选）</Text> : null}
            </Text>
            {field.kind === 'choice' || field.kind === 'multi' ? (
              <View style={styles.options}>
                {(field.options ?? []).map((option) => {
                  const on = picked.includes(option.label)
                  return (
                    <Button
                      key={option.label}
                      compact
                      label={on ? `✓ ${option.label}` : option.label}
                      variant={on ? 'primary' : 'secondary'}
                      accessibilityHint={option.description}
                      disabled={busy}
                      onPress={() => field.kind === 'multi'
                        ? set(field.name, on ? picked.filter((item) => item !== option.label) : [...picked, option.label])
                        : set(field.name, on ? '' : option.label)}
                    />
                  )
                })}
              </View>
            ) : (
              <Input
                value={typeof value === 'string' ? value : ''}
                onChangeText={(text) => set(field.name, text)}
                multiline={field.kind === 'text'}
                keyboardType={field.kind === 'number' || field.kind === 'range' ? 'numeric' : 'default'}
                placeholder={hintOf(field)}
                accessibilityLabel={field.label}
                editable={!busy}
              />
            )}
          </View>
        )
      })}
      <View style={styles.row}>
        <Button label="跳过" variant="ghost" busy={busy} onPress={onSkip} />
        <Button label="发送回答" variant="primary" busy={busy} disabled={!ready} style={styles.flex} onPress={submit} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  form: { gap: space[3], marginTop: space[1] },
  field: { gap: space[1] },
  label: { fontSize: font.sm, fontWeight: weight.medium },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  row: { flexDirection: 'row', gap: space[2] },
  flex: { flex: 1 }
})
