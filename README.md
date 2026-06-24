# Gestión de Espacios · Facultad de Filosofía y Letras

Aplicación web (HTML/JS, sin servidor) para reservar los espacios de la Facultad.
Los datos **no se guardan en el navegador**: se leen y escriben en un archivo
`gestion-espacios.json` dentro de una carpeta que tú eliges (ponla en **OneDrive**
para que el resto de personas vea los cambios).

## Archivos del repositorio
- `index.html` — interfaz y estilos
- `app.js` — lógica de la aplicación
- `logo.png` — logotipo de la Facultad (mantén el tuyo con este nombre)
- `README.md`

## Puesta en marcha
1. Sube los archivos a un repositorio de GitHub y activa **GitHub Pages**
   (Settings → Pages → Deploy from branch). Necesitas **HTTPS**; el acceso a
   carpetas no funciona abriendo el archivo con `file://`.
2. Requiere navegador de escritorio **Chromium** (Google Chrome, Microsoft Edge
   u Opera), que admite el acceso seguro a carpetas locales.
3. La primera vez, pulsa **Conectar carpeta de datos** y elige la carpeta de
   OneDrive. La app la recuerda; después siempre lee y escribe ahí.

## Funcionalidades
- **Reservar** — reserva puntual de cualquier espacio, de 8:00 a 22:00 en tramos
  de 30 min, todos los días. Persona y motivo obligatorios; necesidades opcional.
  Bloqueo automático de dobles reservas.
- **Disponibilidad** — rejilla semanal por espacio con colorimetría (verde libre,
  azul ocupado). En la rejilla solo se muestra el **motivo**, no la persona; el
  detalle completo aparece al hacer clic. Clic en un hueco libre para reservarlo.
- **Buscar espacio** *(nuevo)* — búsqueda inversa: indicas fecha, franja,
  capacidad mínima, planta y dotación, y la app lista los espacios libres que
  cumplen, ordenados del más ajustado al más grande. Botón directo para reservar.
- **Consultas** — por espacio (rango de fechas), por planta, por **periodo entre
  dos fechas** y por persona. Cada consulta genera un **informe imprimible en PDF**
  (con «Guardar como PDF» del navegador).
- **Espacios** — crear, editar y eliminar espacios (planta, capacidad, dotación).
  Vienen cargadas las 33 aulas + Paraninfo, Salón de Actos, Sala Polivalente,
  Vestíbulo y Sala de Ordenadores (valores por defecto editables).
- **Datos** — recargar, cambiar carpeta, descargar/importar copia de seguridad.

## Novedades de esta versión
### 1. Reservas periódicas (series)
En **Reservar**, activa *Reserva periódica*: marca los días de la semana y la
fecha de fin, y la app crea de golpe todas las sesiones del intervalo con el mismo
horario. Las sesiones que choquen con una reserva existente se **omiten y se
listan** en el resumen; el resto se crean. Cada sesión puede cancelarse de forma
individual sin afectar al resto, o puedes **cancelar la serie completa** desde el
detalle de cualquiera de sus sesiones.

### 2. Búsqueda inversa por requisitos
En **Buscar espacio**, en lugar de revisar espacio por espacio, describes lo que
necesitas («60 personas, jueves 16:00–18:00, con proyector») y obtienes los
espacios libres que cumplen, con su capacidad y dotación, listos para reservar.

## Sincronización y seguridad de datos
- Antes de cada guardado, la app **vuelve a leer** el archivo del disco y combina
  por reserva, reduciendo el riesgo de pisar cambios de otra persona.
- Cada guardado deja una **copia con fecha y hora** en la subcarpeta `copias/`
  (se conservan las últimas 30). Si algún día falta el archivo principal, al
  conectar la app ofrece **restaurarlo** desde la copia más reciente.

## Notas
- Para un control de acceso real (que nadie pueda borrar el archivo) habría que
  pasar a un backend (lista de SharePoint vía Microsoft Graph, Supabase, etc.);
  el modelo de archivo en carpeta es el más simple y sin servidor.
