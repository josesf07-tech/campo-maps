# Cómo compilar e instalar JoseScan

Instrucciones para generar el proyecto Xcode, firmarlo e instalar la app en un
iPhone o iPad propio. No hace falta pagar el programa de desarrolladores para
usarla en tus propios equipos.

---

## 1. Requisitos

| Requisito | Detalle |
|---|---|
| Mac | macOS con **Xcode 15 o superior** (Xcode sólo existe para macOS; no hay forma de compilar esto en Windows, Linux ni en el propio iPhone) |
| Cuenta de desarrollador | Basta un **Apple ID gratuito**. Firma la app durante 7 días y permite hasta 3 apps instaladas a la vez en tus dispositivos. Con la cuenta de pago (99 USD/año) la firma dura un año |
| Dispositivo | iPhone o iPad **con LiDAR** e **iOS 16 o superior**. Ver la tabla de equipos en [`README.md`](README.md#2-requisitos-de-hardware) |
| Cable | Lightning o USB-C para el primer despliegue (después se puede usar red inalámbrica) |
| XcodeGen | `brew install xcodegen` (opcional: ver el apartado 7 para la alternativa manual) |

**El simulador de iOS no sirve.** ARKit no funciona en el simulador: la app
compila, pero al abrir *Escanear* no habrá cámara ni sensor. Todo el trabajo de
captura hay que probarlo en un dispositivo físico.

---

## 2. Generar el proyecto y abrirlo

XcodeGen construye el `.xcodeproj` a partir de `project.yml`. El `.xcodeproj`
es un artefacto generado y **no está versionado** (ver `ios/.gitignore`), así
que este paso es obligatorio en un clon nuevo.

```bash
# 1. Instalar XcodeGen (una sola vez)
brew install xcodegen

# 2. Generar el proyecto
cd ios/JoseScan
xcodegen generate

# 3. Abrirlo
open JoseScan.xcodeproj
```

`xcodegen generate` crea dos targets:

| Target | Qué es |
|---|---|
| `JoseScan` | la app (`com.josemaps.josescan`, iOS 16+, iPhone y iPad) |
| `JoseScanTests` | pruebas unitarias XCTest, tomadas de `ios/JoseScanTests/` |

Cada vez que añadas, muevas o borres archivos fuente, vuelve a ejecutar
`xcodegen generate`: `project.yml` referencia carpetas completas, no archivos
sueltos.

---

## 3. Firmar

1. En Xcode: **Xcode → Settings… → Accounts → +** y añade tu Apple ID.
2. En el navegador de proyecto, selecciona el proyecto **JoseScan** → target
   **JoseScan** → pestaña **Signing & Capabilities**.
3. Deja marcado **Automatically manage signing** (el `project.yml` ya fija
   `CODE_SIGN_STYLE = Automatic`).
4. En **Team**, elige tu equipo. Con un Apple ID gratuito aparece como
   *"Tu Nombre (Personal Team)"*.
5. Si Xcode se queja de que el bundle identifier ya está en uso —pasa a menudo
   con `com.josemaps.josescan`—, **cámbialo por uno tuyo**, por ejemplo
   `com.tunombre.josescan`. Puedes hacerlo de dos formas:

   - directamente en Xcode, en el campo **Bundle Identifier**, o
   - en `project.yml`, cambiando `PRODUCT_BUNDLE_IDENTIFIER` y volviendo a
     ejecutar `xcodegen generate` (así el cambio sobrevive a la regeneración).

6. Repite la elección de equipo en el target **JoseScanTests** si Xcode lo pide.

---

## 4. Ejecutar en el dispositivo

1. Conecta el iPhone o iPad por cable y desbloquéalo. Acepta **Confiar en este
   computador** si aparece.
2. En la barra superior de Xcode, en el selector de destino, elige **tu
   dispositivo por su nombre** — no un simulador.
3. Pulsa **Run** (`Cmd+R`).
4. La primera vez la instalación fallará con **"Untrusted Developer"**: hay que
   confiar en el certificado desde el propio dispositivo (apartado 5).
5. Al abrir la app, iOS pedirá el permiso de **cámara** y, al anclar por primera
   vez, el de **ubicación**. Ambos hay que concederlos: sin cámara no hay
   escaneo, sin ubicación no hay georreferenciación.

Para trabajar sin cable: **Window → Devices and Simulators**, selecciona el
dispositivo y marca **Connect via network**. Después el equipo aparece en el
selector mientras esté en la misma red Wi-Fi.

---

## 5. Confiar en el certificado de desarrollador en el iPhone

Con un Apple ID gratuito, iOS bloquea la app hasta que la autorices a mano:

```
Ajustes → General → VPN y gestión de dispositivos
   → Apps de desarrollador
      → "Apple Development: tu-correo@ejemplo.com"
         → Confiar
            → Confiar (en la confirmación)
```

En algunas versiones de iOS la ruta es **Ajustes → General → Gestión de
perfiles y dispositivos**. Después de confiar, la app abre con normalidad.

**El perfil gratuito caduca a los 7 días.** Cuando pase, la app dejará de
abrirse y hay que volver a ejecutarla desde Xcode (`Cmd+R`) para renovar la
firma. Con una cuenta de pago la firma dura un año. Los escaneos guardados no
se pierden por la caducidad, sólo si desinstalas la app.

---

## 6. Pruebas

```
Cmd+U          en Xcode  (esquema JoseScan, configuración Debug)
```

O desde la terminal:

```bash
cd ios/JoseScan
xcodebuild test \
  -project JoseScan.xcodeproj \
  -scheme JoseScan \
  -destination 'platform=iOS Simulator,name=iPhone 15'
```

Las pruebas **sí corren en el simulador**, porque cubren únicamente lógica pura
que no toca ARKit ni la cámara:

| Área | Qué se comprueba |
|---|---|
| Geometría (`ScanTypes`) | `BoundingBox` (expansión, centro, tamaño, diagonal, caja vacía), consistencia de `PointCloud` y `ScanMesh`, `surfaceArea()` |
| `ScanConfiguration` | `saneada()` acota todos los rangos; decodificación tolerante a claves ausentes; `requiereReinicioAR(respectoA:)` |
| `VoxelDownsampler` | dos puntos en el mismo vóxel colapsan en uno y se promedian; se respeta `maxPuntos`; `proporcionAltaConfianza` |
| `PLYWriter` | encabezado exacto (binario y ASCII), 16 bytes por punto, valores por omisión de color y confianza |
| `OBJWriter` | conteo de `v`/`vn`/`f`, agrupación por clasificación, referencia `mtllib` |
| `STLWriter` | 84 bytes de cabecera + 50 por triángulo, normales calculadas y triángulos degenerados descartados |
| `ZipArchive` | CRC-32 contra vectores conocidos, firmas y desplazamientos del directorio central, fecha MS-DOS, rechazo de nombres vacíos o repetidos |
| Geo | ARKit → ENU con rumbos conocidos, ida y vuelta ENU ↔ WGS84, WGS84 ↔ EPSG:9377 contra valores de referencia |
| `ScanMetadata` | ida y vuelta JSON con fechas ISO-8601, compatibilidad con `docs/FORMATO-ESCANEO.md` |

El esquema tiene `gatherCoverageData: true`: la cobertura se ve en
**Report navigator → última prueba → Coverage**.

`project.yml` marca la ruta de pruebas como `optional: true`, así que el
proyecto se genera aunque `ios/JoseScanTests/` esté vacío.

---

## 7. Alternativa sin XcodeGen

Si no quieres instalar Homebrew ni XcodeGen, puedes armar el proyecto a mano:

1. **File → New → Project… → iOS → App**.
   - Product Name: `JoseScan`
   - Interface: **SwiftUI**
   - Language: **Swift**
   - Deja sin marcar Core Data y Tests (o marca Tests si quieres el target).
2. Guarda el proyecto **fuera** de `ios/JoseScan/` para no mezclarlo con los
   archivos del repositorio.
3. **Borra** del proyecto recién creado el `ContentView.swift` y el
   `<Nombre>App.swift` que genera la plantilla: `App/JoseScanApp.swift` ya trae
   el `@main`, y tener dos provoca el error *"'main' attribute cannot be used
   in a module that contains top-level code"*.
4. Arrastra al navegador de proyecto, desde el Finder, estas carpetas:
   - `ios/JoseScan/App`
   - `ios/JoseScan/Sources`
   - `ios/JoseScanTests` (sólo si creaste el target de pruebas)

   En el diálogo marca **Create groups** (no *folder references*) y
   **Add to targets: JoseScan** — y `JoseScanTests` para la carpeta de pruebas.
5. **Excluye `App/Info.plist` de la fase Copy Bundle Resources** (target →
   Build Phases → Copy Bundle Resources → seleccionarlo → `−`) y apunta la
   compilación a él: target → Build Settings → **Info.plist File** =
   `App/Info.plist`, y **Generate Info.plist File** = `No`.
6. Ajusta en Build Settings:
   - **iOS Deployment Target** = `16.0`
   - **Targeted Device Families** = `1,2` (iPhone y iPad)
   - **Swift Language Version** = `5`
   - **Asset Catalog App Icon Set Name** = `AppIcon`
   - **Asset Catalog Global Accent Color Name** = `AccentColor`
7. Copia las claves del `Info.plist` (lista literal en el apartado 7.1) si
   prefieres usar el `Info.plist` que generó la plantilla en lugar del del
   repositorio.

### 7.1 Claves del `Info.plist` (lista literal)

Son las de `ios/JoseScan/App/Info.plist`. Los textos van tal cual, en español.

| Clave | Tipo | Valor |
|---|---|---|
| `CFBundleDevelopmentRegion` | String | `es` |
| `CFBundleDisplayName` | String | `JoseScan` |
| `LSRequiresIPhoneOS` | Boolean | `YES` |
| `ITSAppUsesNonExemptEncryption` | Boolean | `NO` |
| `NSCameraUsageDescription` | String | `JoseScan usa la cámara y el sensor LiDAR para escanear el terreno y las estructuras en campo.` |
| `NSLocationWhenInUseUsageDescription` | String | `La ubicación se usa para georreferenciar cada escaneo en coordenadas MAGNA-SIRGAS.` |
| `NSPhotoLibraryAddUsageDescription` | String | `Se guardan en tus Fotos las miniaturas y las capturas de los escaneos que decidas exportar.` |
| `UIRequiredDeviceCapabilities` | Array de String | `arkit` |
| `UIUserInterfaceStyle` | String | `Dark` |
| `UIApplicationSupportsIndirectInputEvents` | Boolean | `YES` |
| `UILaunchScreen` | Dictionary | vacío |
| `UISupportedInterfaceOrientations` | Array de String | `UIInterfaceOrientationPortrait`, `UIInterfaceOrientationLandscapeLeft`, `UIInterfaceOrientationLandscapeRight` |
| `UISupportedInterfaceOrientations~ipad` | Array de String | las tres anteriores más `UIInterfaceOrientationPortraitUpsideDown` |
| `UIFileSharingEnabled` | Boolean | `YES` |
| `LSSupportsOpeningDocumentsInPlace` | Boolean | `YES` |

Y el tipo de documento propio, para que iOS reconozca los paquetes `.josescan`:

| Clave | Valor |
|---|---|
| `UTExportedTypeDeclarations` → `UTTypeIdentifier` | `com.josemaps.josescan.scan` |
| `UTExportedTypeDeclarations` → `UTTypeDescription` | `Escaneo JoseScan` |
| `UTExportedTypeDeclarations` → `UTTypeConformsTo` | `public.zip-archive` |
| `UTExportedTypeDeclarations` → `UTTypeTagSpecification` → `public.filename-extension` | `josescan` |
| `UTExportedTypeDeclarations` → `UTTypeTagSpecification` → `public.mime-type` | `application/zip` |
| `CFBundleDocumentTypes` → `CFBundleTypeName` | `Escaneo JoseScan` |
| `CFBundleDocumentTypes` → `CFBundleTypeRole` | `Editor` |
| `CFBundleDocumentTypes` → `LSHandlerRank` | `Owner` |
| `CFBundleDocumentTypes` → `LSItemContentTypes` | `com.josemaps.josescan.scan` |

Las claves `CFBundleExecutable`, `CFBundleIdentifier`, `CFBundleName`,
`CFBundleShortVersionString`, `CFBundleVersion`, `CFBundlePackageType` y
`CFBundleInfoDictionaryVersion` las rellena Xcode con sus variables
(`$(PRODUCT_NAME)`, `$(MARKETING_VERSION)`, …); no hace falta copiarlas.

Lo más fácil, de todos modos, es **usar directamente el `Info.plist` del
repositorio** (paso 5) en lugar de transcribir estas claves.

---

## 8. Sacar los escaneos del teléfono

Tres caminos, de más cómodo a más manual:

### 8.1 Compartir desde la propia app

*Escaneos* → toca el escaneo → **Compartir** → elige el formato → se abre la
hoja del sistema: AirDrop, Archivos, Correo, WhatsApp, Drive… Es la vía normal
y la única que permite elegir el formato de exportación.

### 8.2 App Archivos

El `Info.plist` activa `UIFileSharingEnabled` y
`LSSupportsOpeningDocumentsInPlace`, así que la carpeta de la app es visible:

```
Archivos → Explorar → En mi iPhone → JoseScan
```

Desde ahí se copian, mueven o comparten los archivos guardados. También sirve
para **meter** un `.josescan` traído de otro equipo.

### 8.3 AirDrop y Finder

- **AirDrop** desde la hoja de compartir: llega directo al Mac, a la carpeta de
  descargas.
- **Finder** (Mac con cable): selecciona el dispositivo en la barra lateral →
  pestaña **Archivos** → despliega **JoseScan** → arrastra los archivos al
  escritorio. Es el camino para sacar todo de golpe.

Una vez el archivo está en el computador (o en el mismo teléfono), se abre en
el panel **Escaneos 3D** de JoseMaps, o en CloudCompare / QGIS / AutoCAD según
el formato — ver la tabla de formatos en `docs/GUIA-ESCANEO.md`.

---

## 9. Problemas frecuentes

### "Untrusted Developer" al abrir la app

Falta autorizar el certificado en el dispositivo:
**Ajustes → General → VPN y gestión de dispositivos → Apps de desarrollador →
Confiar**. Ver el apartado 5.

### "Unable to install" / "A valid provisioning profile for this executable was not found"

- Comprueba que elegiste un **Team** en *Signing & Capabilities*.
- Cambia el bundle identifier por uno propio (`com.tunombre.josescan`): el
  original puede estar reclamado por otra cuenta.
- Con Apple ID gratuito sólo caben **3 apps** firmadas a la vez: desinstala
  alguna.
- Desconecta y reconecta el dispositivo, y desbloquéalo antes de ejecutar.

### La app se cierra al abrir *Escanear*, o la cámara sale en negro

Falta `NSCameraUsageDescription` en el `Info.plist` que se está compilando (iOS
mata la app en cuanto se pide la cámara sin esa clave), o se negó el permiso.

- Verifica que **Info.plist File** apunta a `App/Info.plist` y que
  **Generate Info.plist File** está en `No`.
- Concede el permiso en **Ajustes → JoseScan → Cámara**.

### "El escaneo no arranca" en el simulador

**ARKit no funciona en el simulador.** Es una limitación de Apple, no un fallo
de la app. Selecciona un dispositivo físico. En el simulador sólo tiene sentido
ejecutar las pruebas (`Cmd+U`).

### La pestaña *Interiores* aparece vacía o da error

**RoomPlan requiere iOS 17 o superior**, aunque la app soporte desde iOS 16.
Actualiza el dispositivo o usa la pestaña *Escanear*, que funciona desde iOS 16.

### Franja de aviso "sin LiDAR" y pestañas de captura bloqueadas

El equipo no tiene sensor LiDAR. Ver la tabla de equipos en
[`README.md`](README.md#2-requisitos-de-hardware). No hay solución por software:
en ese equipo sólo se pueden consultar y exportar escaneos hechos en otro.

### `xcodegen: command not found`

XcodeGen no está instalado o Homebrew no está en el `PATH`:

```bash
brew install xcodegen
xcodegen --version     # debe ser 2.35.0 o superior
```

En Macs con Apple Silicon, Homebrew instala en `/opt/homebrew/bin`; asegúrate
de que esa ruta está en el `PATH` de tu shell.

### Errores de compilación tras añadir archivos

`project.yml` referencia carpetas, no archivos sueltos. Vuelve a ejecutar
`xcodegen generate` y reabre el `.xcodeproj`.

### "'main' attribute cannot be used in a module that contains top-level code"

Hay dos puntos de entrada: el `@main` de `App/JoseScanApp.swift` y el que
generó la plantilla de Xcode. Borra el de la plantilla (apartado 7, paso 3).

### La app dejó de abrirse después de una semana

Es la caducidad de los 7 días del Apple ID gratuito. Conecta el dispositivo y
ejecuta de nuevo desde Xcode (`Cmd+R`) para renovar la firma.
