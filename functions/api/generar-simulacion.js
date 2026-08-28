// functions/api/generar-simulacion.js
//
// Cloudflare Pages Function — intermediario seguro entre el panel y la API de Gemini.
// El panel nunca habla directo con Gemini: le pide a esta función, y esta función
// (que sí puede guardar secretos) habla con Gemini usando la clave guardada en Cloudflare.
//
// Se accede desde el panel como: POST /api/generar-simulacion
//
// Body esperado (JSON):
//   {
//     fotoUrl: "https://.../foto-original.jpg",   // foto actual del cliente
//     material: "tarima laminada",                 // qué suelo simular
//     supabaseUrl: "https://xxxx.supabase.co",      // proyecto de Supabase del cliente de IA Partner
//     supabaseKey: "eyJ...",                         // clave anónima pública de ese Supabase
//     bucket: "fotos-obra"                           // bucket de Storage donde guardar el resultado
//   }
//
// Devuelve (JSON): { fotoResultadoUrl, token }

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { fotoUrl, material, supabaseUrl, supabaseKey, bucket } = body;

    if (!fotoUrl || !material || !supabaseUrl || !supabaseKey || !bucket) {
      return jsonError('Faltan datos para generar la simulación.', 400);
    }

    if (!env.GEMINI_API_KEY) {
      return jsonError('Falta configurar la clave de Gemini en Cloudflare (variable GEMINI_API_KEY).', 500);
    }

    // 1) Descargar la foto original del cliente
    const fotoRes = await fetch(fotoUrl);
    if (!fotoRes.ok) return jsonError('No se pudo leer la foto original del cliente.', 400);
    const fotoBuffer = await fotoRes.arrayBuffer();
    const fotoBase64 = arrayBufferToBase64(fotoBuffer);
    const mimeType = fotoRes.headers.get('content-type') || 'image/jpeg';

    // 2) Pedirle a Gemini (Nano Banana 2 / gemini-3.1-flash-image-preview) que edite la foto
    const prompt = `Reemplaza únicamente el suelo de esta fotografía por ${material}, manteniendo exactamente iguales las paredes, los muebles, la iluminación, la perspectiva y todo lo demás de la habitación. El resultado debe ser fotorrealista. El suelo nuevo debe llenar por completo el área visible de suelo, sin bordes, marcos ni márgenes en blanco alrededor de la imagen generada.`;

    const geminiRes = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { inlineData: { mimeType, data: fotoBase64 } },
                { text: prompt }
              ]
            }
          ]
        })
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return jsonError('Gemini no pudo generar la imagen: ' + errText, 502);
    }

    const geminiData = await geminiRes.json();
    const parts = geminiData?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData);
    if (!imagePart) {
      return jsonError('Gemini no devolvió ninguna imagen. Prueba con otra foto.', 502);
    }

    const imagenBase64 = imagePart.inlineData.data;
    const imagenMime = imagePart.inlineData.mimeType || 'image/png';
    const extension = imagenMime.includes('png') ? 'png' : 'jpg';

    // 3) Subir la imagen generada al Storage de Supabase del cliente
    const token = generarCodigoCorto(7);
    const nombreArchivo = `simulador-resultado/${token}.${extension}`;
    const imagenBuffer = base64ToArrayBuffer(imagenBase64);

    const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${nombreArchivo}`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: 'Bearer ' + supabaseKey,
        'Content-Type': imagenMime
      },
      body: imagenBuffer
    });

    if (!uploadRes.ok) {
      return jsonError('La imagen se generó, pero no se pudo guardar en Supabase.', 502);
    }

    const fotoResultadoUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${nombreArchivo}`;

    return new Response(JSON.stringify({ fotoResultadoUrl, token }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return jsonError(err.message || 'Error desconocido al generar la simulación.', 500);
  }
}

function jsonError(mensaje, status) {
  return new Response(JSON.stringify({ error: mensaje }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function generarCodigoCorto(longitud) {
  // Sin 0/O/1/l/i, igual que el resto de la app, para que no se confundan al leerlo.
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let codigo = '';
  for (let i = 0; i < longitud; i++) {
    codigo += chars[Math.floor(Math.random() * chars.length)];
  }
  return codigo;
}
