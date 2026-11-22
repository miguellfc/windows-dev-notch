@echo off
rem Stands in for `claude -p --output-format json` in work-log.spec.ts (NOTCH_WORKLOG_CLAUDE):
rem ignores its arguments and stdin and prints a fixed summary. ASCII only, no cmd metacharacters.
echo {"type":"result","is_error":false,"result":"{\"title\":\"Integrar la pasarela de pagos en ms-pay\",\"subtasks\":[{\"title\":\"Analizar la API de pagos\",\"status\":\"done\",\"turnIds\":[\"p-1\"]},{\"title\":\"Validar la firma del webhook\",\"status\":\"pending\",\"turnIds\":[]}]}"}
exit /b 0
