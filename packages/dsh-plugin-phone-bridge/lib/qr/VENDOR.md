# Vendored QR encoder

`lib/qr/vendor/` is adapted from the QR Code generator shipped with
[`qrcode-terminal`](https://github.com/gtanner/qrcode-terminal)
(`vendor/QRCode/`), itself a Node port of Kazuhiko Arase's QRCode for
JavaScript.

- Original: <http://www.d-project.com/>
- Copyright (c) 2009 Kazuhiko Arase
- License: MIT (reproduced below)
- "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.

Changes made for this package:

- CommonJS `require`/`module.exports` converted to ESM imports/exports.
- `QR8bitByte` now encodes UTF-8 bytes instead of raw UTF-16 code units.
- No changes to the encoding tables, Reed-Solomon math, masking, or placement.

The bridge payload is ASCII today, but UTF-8 keeps the encoder correct for a
non-ASCII origin or host label.

## MIT license

Copyright (c) 2009 Kazuhiko Arase

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
