const fs = require('fs');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const GAS_URL = "https://script.google.com/macros/s/AKfycbzBMx-fZAifindtXbsXVueYEYQz4uBT1cA8CnlrZH3MTHEyR4RMv6uxaPhdKwskiP4T/exec";

async function fetchAndParsePDF() {
    console.log("🌐 Fetching PDF from Google Apps Script...");
    
    const response = await fetch(GAS_URL, { redirect: 'follow' });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Google Script returned HTTP ${response.status} ${response.statusText}\nDetails: ${errorText.substring(0, 500)}`);
    }

    const json = await response.json();
    if (!json.success) throw new Error("GAS Error: " + json.error);

    console.log(`📄 Received PDF: ${json.fileNameUsed || "Unknown Name"}`);
    const pdfBuffer = Buffer.from(json.data, 'base64');
    const pdfData = new Uint8Array(pdfBuffer);
    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
    console.log(`📑 Total Pages Found in PDF: ${pdf.numPages}`);

    let globalData = [];
    let currentMonthStr = "Unknown Month";
    let maxDays = 31; 

    const fixSpacing = (str) => {
        if (!str) return "N/A";
        return str.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    };

    let dayColumns = [];
    let reportingX = 0;
    let sanctionerX = 0;
    let contractorX = 0;

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        
        let items = textContent.items
            .map(item => ({ 
                text: item.str, 
                x: item.transform[4], 
                y: item.transform[5],
                width: item.width || (item.str.length * 5)
            }))
            .filter(item => item.text.trim() !== ''); 

        if (items.length === 0) continue;

        // SMART VERTICAL SCANNER: Glues multi-line cells like HO + (ROTA) together before rows are even built
        for (let a = 0; a < items.length; a++) {
            let t1 = items[a].text.trim().toUpperCase();
            if (t1 === 'HO' || t1 === 'WHO' || t1 === 'SLWP') {
                for (let b = 0; b < items.length; b++) {
                    if (a === b) continue;
                    let t2 = items[b].text.trim().toUpperCase();
                    if (t2 === '(ROTA)' || t2 === '(PENDING)') {
                        let xDiff = Math.abs(items[a].x - items[b].x);
                        let yDiff = Math.abs(items[a].y - items[b].y);
                        // If they are strictly in the same column and adjacent lines, merge them!
                        if (xDiff < 15 && yDiff < 15) {
                            items[a].text += " " + items[b].text;
                            items[b].text = ""; // Empty out the bottom part
                        }
                    }
                }
            }
        }
        items = items.filter(itm => itm.text.trim() !== '');

        // strictly group elements by Y coordinate to form rows without bleeding into the next employee
        let rows = [];
        items.forEach(item => {
            let closestRow = null;
            let minDiff = 4.5; // Very tight tolerance prevents rows from merging!

            for (let r of rows) {
                let diff = Math.abs(r.y - item.y);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestRow = r;
                }
            }

            if (closestRow) {
                closestRow.items.push(item);
            } else {
                rows.push({ y: item.y, items: [item] });
            }
        });

        for (let row of rows) {
            row.items.sort((a, b) => a.x - b.x); 

            let fullText = row.items.map(itm => itm.text).join(" ").replace(/\s+/g, ' ').trim();
            fullText = fullText.replace(/HO\s*\(ROTA\)/gi, 'HO(ROTA)').replace(/WHO\s*\(ROTA\)/gi, 'WHO(ROTA)');

            if (currentMonthStr === "Unknown Month") {
                let monthMatch = fullText.match(/Month\s*of\s*([A-Za-z]+)\s*(\d{4})/i) || fullText.replace(/\s/g, '').match(/Monthof([A-Za-z]+)(\d{4})/i);
                if (monthMatch) currentMonthStr = monthMatch[1] + " " + monthMatch[2];
            }

            // Detect Header Row
            if (fullText.includes("Contractor") && fullText.includes("Reporting")) {
                dayColumns = []; 
                let pastContractor = false;
                
                for (let itm of row.items) {
                    let text = itm.text.trim();
                    if (text === "Contractor") {
                        pastContractor = true;
                        contractorX = itm.x;
                    } else if (text.includes("Reporting")) {
                        pastContractor = false;
                        reportingX = itm.x;
                    } else if (text.includes("Sanctioner")) {
                        sanctionerX = itm.x;
                    } else if (pastContractor && /^\d{1,2}$/.test(text)) {
                        dayColumns.push({
                            day: parseInt(text),
                            xCenter: itm.x + (itm.width / 2) 
                        });
                    }
                }
                if (dayColumns.length > 0) maxDays = Math.max(...dayColumns.map(d => d.day));
                continue;
            }

            let regex = /^([A-Z0-9]+\s*[-–—]?\s*\d+)\s+(.+?)\s+(Active|Left)/i;
            let match = fullText.match(regex);

            if (!match) continue; 

            let code = match[1].replace(/\s+/g, ''); 
            
            // Failsafe: Remove any rogue IDs that managed to sneak into the name string
            let rawName = match[2];
            rawName = rawName.replace(/[A-Z0-9]{2,4}\s*[-–—]\s*\d+/gi, '').trim(); 
            let name = fixSpacing(rawName); 
            
            let status = match[3];

            let contractor = "Unknown";
            let datesArray = new Array(31).fill('-');
            let tlTokens = [];
            let sancTokens = [];

            for (let itm of row.items) {
                let text = itm.text.trim();
                let itmCenter = itm.x + (itm.width / 2);

                if (contractorX > 0 && itm.x < contractorX - 20) continue;

                // Contractor column extraction
                if (dayColumns.length > 0 && itmCenter >= contractorX - 10 && itm.x < dayColumns[0].xCenter - 10) {
                    if (contractor === "Unknown") contractor = text;
                    else contractor += " " + text;
                    continue;
                }

                // Days columns extraction
                if (dayColumns.length > 0 && itm.x >= dayColumns[0].xCenter - 15 && itm.x < reportingX - 15) {
                    let ctext = text.toUpperCase().replace(/\s+/g, '');
                    let finalVal = null;
                    
                    if (ctext === 'HO(ROTA)') finalVal = 'HO (ROTA)';
                    else if (ctext === 'WHO(ROTA)') finalVal = 'WHO (ROTA)';
                    else if (ctext.includes('SLWP')) finalVal = 'SLWP';
                    else if (ctext.includes('LVP')) finalVal = 'LVP';
                    else if (ctext.includes('U/A')) finalVal = 'U/A';
                    else if (ctext === 'WO' || ctext.includes('W/O')) finalVal = 'WO';
                    else if (['P', 'A', 'HD', 'FD', 'MP', 'L', 'HO', 'CF'].includes(ctext)) finalVal = ctext;
                    else if (ctext === '-' || ctext === '--') finalVal = '-';

                    if (finalVal) {
                        let closestDay = null;
                        let currentMinDiff = 30; 
                        
                        for (let col of dayColumns) {
                            let diff = Math.abs(itmCenter - col.xCenter);
                            if (diff < currentMinDiff) {
                                currentMinDiff = diff;
                                closestDay = col.day;
                            }
                        }
                        if (closestDay !== null) {
                            datesArray[closestDay - 1] = finalVal;
                        }
                    }
                    continue;
                }

                // TL & Sanctioner Extraction
                if (reportingX > 0 && itm.x >= reportingX - 15 && (sanctionerX === 0 || itm.x < sanctionerX - 15)) {
                    tlTokens.push(text);
                    continue;
                }
                if (sanctionerX > 0 && itm.x >= sanctionerX - 15) {
                    sancTokens.push(text);
                }
            }

            contractor = contractor.replace(/\s+/g, ' ').trim();
            if (contractor === "Unknown" || contractor === "") {
                let remainderMatch = fullText.match(/(Active|Left)\s+(.+)$/i);
                if (remainderMatch) {
                    let rem = remainderMatch[2].split(/\s+/);
                    contractor = rem[0];
                }
            }
            
            let knownContractors = ['Dibya Industrial Service', 'Om Sai Krupa Enterprise', 'Om Sai Krupa', 'YASHASWI', 'VASUDEVA', 'ANANYA', 'ADECCO', 'MATHEW', 'Dibya', 'ESJAY', 'Om Sai', 'SHAM'];
            for (let c of knownContractors) {
                if (contractor.toLowerCase().includes(c.toLowerCase().split(' ')[0])) {
                    contractor = c;
                    break;
                }
            }

            let tl = tlTokens.length > 0 ? fixSpacing(tlTokens.join(' ')) : "N/A";
            let sanctioner = sancTokens.length > 0 ? fixSpacing(sancTokens.join(' ')) : "N/A";

            if (name.length > 2) {
                let existingEmp = globalData.find(e => e.code === code);
                if (existingEmp) {
                    for (let d = 0; d < 31; d++) {
                        if (datesArray[d] !== '-' && datesArray[d] !== '--') {
                            existingEmp.dates[d] = datesArray[d];
                        }
                    }
                    if (existingEmp.tl === "N/A" && tl !== "N/A") existingEmp.tl = tl;
                    if (existingEmp.sanctioner === "N/A" && sanctioner !== "N/A") existingEmp.sanctioner = sanctioner;
                } else {
                    globalData.push({ code, name, status, contractor, dates: datesArray, tl, sanctioner });
                }
            }
        }
    }

    console.log(`✅ Successfully parsed ${globalData.length} employee records.`);
    fs.writeFileSync('data.json', JSON.stringify({ currentMonthStr, globalData }));
    console.log("🚀 Saved to data.json successfully!");
}

fetchAndParsePDF().catch(err => { 
    console.error("❌ Fatal Error:", err.message);
    process.exit(1); 
});
