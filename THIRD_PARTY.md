# Third-party components and image/model provenance

The application does not generate packaging, labels, logos or missing product regions. Browser image processing runs locally. It requests model and WASM files from this application's own origin only. Search/optional vision integrations, if configured separately, have their own terms.

## U²-Net / U2NetP

- Authors: Xuebin Qin, Zichen Zhang, Chenyang Huang, Masood Dehghan, Osmar R. Zaiane and Martin Jagersand.
- Official project: <https://github.com/xuebinqin/U-2-Net>.
- Upstream repository license: Apache License 2.0, <https://github.com/xuebinqin/U-2-Net/blob/master/LICENSE>.
- This app uses only the small general-purpose U2NetP model, converted to ONNX and distributed in the official rembg release: <https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx>.
- Official rembg model selector/checksum: <https://github.com/danielgatis/rembg/blob/main/rembg/sessions/u2netp.py>.
- Exact installed artifact: `public/models/u2netp.onnx`, 4,574,861 bytes.
- SHA-256: `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8`.
- MD5 published by rembg: `8e83ca70e441ab06c318d82300c84806`.
- Upstream Apache-2.0 license is retained at `public/models/U-2-Net-LICENSE.txt`. Upstream publishes no separate model-specific license for U2NetP; the provenance here is the Apache-2.0 project and its rembg conversion, rather than a claim that every rembg model has that license. Preserve both this notice and the license when distributing the artifact.
- Paper: Qin et al., *U²-Net: Going Deeper with Nested U-Structure for Salient Object Detection*, Pattern Recognition (2020), <https://arxiv.org/abs/2005.09007>.

## rembg preprocessing reference

Normalization and output mask handling follow the public rembg reference algorithm (RGB image/global maximum, ImageNet channel mean/std, NCHW float32, min/max output normalization). This JavaScript implementation uses browser resampling and bilinear mask resizing; it does not claim bit-for-bit equivalence with PIL LANCZOS or contain the rembg Python runtime.

- Source: <https://github.com/danielgatis/rembg/blob/main/rembg/sessions/base.py> and the U2NetP session linked above.
- Reference code license: MIT, copyright Daniel Gatis. <https://github.com/danielgatis/rembg/blob/main/LICENSE.txt>.
- MIT notice: Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Do not replace this artifact with rembg's current default BRIA RMBG-2.0 model without reviewing its separate commercial license. The MIT license of rembg itself is not a license for all model weights.

## ONNX Runtime Web

- Project: <https://github.com/microsoft/onnxruntime>.
- License: MIT, copyright Microsoft Corporation. The installed npm package includes its license; retain it with redistributed WASM/runtime assets.
- Browser execution provider: local WASM; one thread; no paid inference API. Local runtime assets must be copied from exactly the installed `onnxruntime-web` version into `public/onnx/`.
- Configuration reference: <https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html>.

## Product photographs

The model/runtime licenses do not grant rights to photographs downloaded from retailers or manufacturers. Keep original page URLs, source metadata, rights status and user confirmation in the result report. User-uploaded or photographed assets also require the user's authority to use them. Unknown rights do not become an open license after removing the background.

## Output limitations

Canvas JPEG encoding uses the browser's encoder. The app requests the configured JPEG quality and produces an opaque white image, but cannot force chroma subsampling, baseline encoding or a specific ICC profile across all browsers. Background boundary pixels can vary slightly after lossy JPEG compression. Import should be checked in the user's actual Shelf product/version. A front image alone is not a claim of full GS1 image-set compliance.

U2NetP is a generic, lightweight segmentation model. Transparent containers, white packaging, thin protrusions, connected shadows and small labels require visual review. The original photograph remains available; no model score proves SKU identity or photo quality.
