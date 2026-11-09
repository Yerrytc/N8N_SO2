# RETEQUE-OS: pedidos de restaurante por WhatsApp

Proyecto grupal del curso **Sistemas Operativos II** (Universidad Privada de Tacna, Escuela de Ingeniería de Sistemas), a cargo del Dr. Renzo Alberto Taco Coayla.

**Integrantes:** Milton H. Flores Chino, Manuel Andree Dongo Palza, Yerry Maycol Tarqui Collatupa, Kevin Elvis Hinojosa CalloApaza y Usher Damiron Halanocca Rojas.

## ¿De qué trata el proyecto?

Muchos restaurantes pequeños reciben sus pedidos por WhatsApp: una persona lee cada mensaje, anota el pedido, confirma el pago y avisa a la cocina. Cuando hay muchos clientes a la vez, se pierden mensajes, se cometen errores y la gente espera de más.

Nuestra propuesta es que **el cliente haga su pedido por WhatsApp como siempre y el sistema se encargue del resto de forma automática**:

- Atiende al cliente y registra lo que pide.
- Recibe y revisa la captura del pago.
- Avisa a la cocina en una pantalla, con el estado de cada pedido.
- Avisa al cliente cuando su pedido está listo y, si corresponde, en camino.
- Siempre permite que una persona del restaurante intervenga cuando haga falta.

Para esto se usa una herramienta de automatización llamada **n8n**, que conecta WhatsApp con el resto del sistema.

## ¿Qué hay en este repositorio?

### Unidad I: investigación
Se encuentra en esta misma carpeta, junto a este archivo:

- `Artitculo_Grupo_n8n.docx` y `.pdf`: artículo con la revisión de la investigación sobre n8n y automatización.
- `DIAPOS_N8N__nuevo.pdf`: diapositivas de la exposición.
- `EnlaceDrive_GrupoN8N_40pds.txt`: enlace a la carpeta de Drive con los 40 artículos y fuentes consultadas.

### Unidad II: diseño de la solución
Se encuentra en la carpeta [`Unidad_2`](Unidad_2):

- **Informe** (`Informe_U2_...docx` y `.pdf`): explica cómo quedaría instalado y funcionando el sistema. Incluye dónde se aloja, cómo se conecta, cómo se protege, cómo se hacen las copias de seguridad, cuánto costaría, quién se encarga de qué y cómo se probará.
- **Diapositivas** (`DIAPOS_DISENO_U2_...pdf` y `.pptx`): resumen del informe para la exposición.
- **Prototipo** (`Prototipo_U2`): una versión mínima del sistema hecha para comprobar que las reglas del diseño funcionan (por ejemplo, que un pedido no se registre dos veces y que no se pierdan mensajes). Tiene su propio `README.md` con las instrucciones para repetir las pruebas.

## Lo más importante del diseño

- **Dónde funciona:** en un servidor virtual en la nube (4 GB de memoria y 80 GB de disco), no en una computadora del restaurante.
- **Seguridad:** solo quedan abiertos los accesos necesarios; el resto está cerrado y la administración se hace por una conexión privada.
- **Copias de seguridad:** se guarda una copia cifrada cada día fuera del servidor, para recuperar el sistema en pocas horas si algo falla.
- **Costo estimado:** unos S/ 264 al mes por la infraestructura, más lo que cobre WhatsApp por mensajes según el volumen de pedidos.

## ¿Qué tan comprobado está?

El prototipo se probó en una computadora de desarrollo: la lógica de los pedidos, la base de datos y la configuración pasaron las pruebas, incluyendo una simulación de 50 pedidos sin duplicados ni pérdidas. **Todavía no se probó en el servidor real ni con WhatsApp real**; eso se hará en la siguiente unidad.

## Enlaces

- Carpeta de Drive del proyecto: https://drive.google.com/drive/folders/1D0T0N4jpK7AIfQZyX4QkX4prb8k3Pmf_?usp=sharing
