const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');

// Generate the PDF in memory
function createPDF(scanData) {
    return new Promise((resolve) => {
        const doc = new PDFDocument();
        const buffers = [];

        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
            resolve(Buffer.concat(buffers));
        });

        doc.fontSize(20).text('VibeCode Labs - Compliance Report', { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(`Website Scanned: ${scanData.url}`);
        doc.text(`Date: ${new Date().toLocaleDateString()}`);
        doc.moveDown();

        doc.text('Results:', { underline: true });
        doc.moveDown();

        // GDPR
        if (scanData.results.gdprRisk) {
            doc.fillColor('red').text('FAIL: GDPR Risk (External Google Fonts detected)');
        } else {
            doc.fillColor('green').text('PASS: GDPR Compliant Fonts');
        }

        // Legal
        if (scanData.results.missingPrivacy) {
            doc.fillColor('red').text('FAIL: Missing Legal Pages (No Privacy Policy/TOS found)');
        } else {
            doc.fillColor('green').text('PASS: Legal Pages Found');
        }

        // Mobile
        if (scanData.results.missingViewport) {
            doc.fillColor('red').text('FAIL: Mobile Risk (Missing viewport meta tag)');
        } else {
            doc.fillColor('green').text('PASS: Mobile Responsive Setup');
        }

        doc.moveDown();
        doc.fillColor('black').text('Need help fixing these issues? Reply to this email.', { italic: true });
        doc.end();
    });
}

async function sendReportEmail(toEmail, scanData) {
    try {
        // Generate Ethereal test account
        let testAccount = await nodemailer.createTestAccount();

        let transporter = nodemailer.createTransport({
            host: "smtp.ethereal.email",
            port: 587,
            secure: false, 
            auth: {
                user: testAccount.user,
                pass: testAccount.pass,
            },
        });

        // Generate the PDF Buffer
        const pdfBuffer = await createPDF(scanData);

        let info = await transporter.sendMail({
            from: '"VibeCode Labs" <hello@vibecodelabs.be>',
            to: toEmail,
            subject: `Compliance Report for ${scanData.url}`,
            text: "Here is your website compliance report. Please see the attached PDF.",
            attachments: [
                {
                    filename: 'Compliance-Report.pdf',
                    content: pdfBuffer,
                    contentType: 'application/pdf'
                }
            ]
        });

        console.log("Message sent: %s", info.messageId);
        console.log("Preview URL: %s", nodemailer.getTestMessageUrl(info));
        return true;

    } catch (error) {
        console.error("Email error:", error);
        return false;
    }
}

module.exports = { sendReportEmail };
