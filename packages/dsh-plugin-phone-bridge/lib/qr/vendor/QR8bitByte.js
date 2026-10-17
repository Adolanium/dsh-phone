// Vendored from qrcode-terminal vendor/QRCode (Copyright (c) 2009 Kazuhiko Arase, MIT).
// Converted to ESM; see ../VENDOR.md.
import QRMode from './QRMode.js';

function QR8bitByte(data) {
	this.mode = QRMode.MODE_8BIT_BYTE;
	// The original implementation wrote UTF-16 code units as bytes. The bridge
	// payload is ASCII today, but encoding UTF-8 keeps the module correct for a
	// non-ASCII host name or origin.
	this.bytes = Buffer.from(String(data), 'utf8');
}

QR8bitByte.prototype = {

	getLength : function() {
		return this.bytes.length;
	},
	
	write : function(buffer) {
		for (var i = 0; i < this.bytes.length; i++) {
			buffer.put(this.bytes[i], 8);
		}
	}
};

export default QR8bitByte
