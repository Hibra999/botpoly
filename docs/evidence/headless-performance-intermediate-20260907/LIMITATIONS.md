# Medición intermedia: menor memoria, crecimiento aún fuera del criterio

Código 9215314: consultas comunes reutilizadas, pero inserciones de observaciones aún preparadas por frame. El pico con trabajadores bajó a 311–334 MiB frente a 450–451 MiB. No se aprueba: pendiente lineal superior a 5 MiB/min tras 30 segundos. Se conserva el ensayo completo antes de reutilizar también las consultas de observaciones. No hubo otra tarea pesada de Codex durante esta medición; el servicio antiguo permaneció activo en el host compartido.
