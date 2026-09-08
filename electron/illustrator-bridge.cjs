const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Executes a raw ExtendScript (.jsx) string in Adobe Illustrator via AppleScript.
 * This is the most reliable way to perform deep DOM manipulation natively on macOS.
 */
function runExtendScript(scriptString) {
  return new Promise((resolve, reject) => {
    // 1. Write the ExtendScript to a temporary .jsx file
    const jsxPath = path.join(os.tmpdir(), `ai_script_${Date.now()}.jsx`);
    fs.writeFileSync(jsxPath, scriptString, 'utf8');

    // 2. Convert UNIX path to AppleScript POSIX path format
    const appleScript = `
      try
        tell application "Adobe Illustrator"
          activate
          set scriptResult to do javascript file (POSIX file "${jsxPath}")
          return scriptResult
        end tell
      on error errMsg
        return "ERROR: " & errMsg
      end try
    `;

    // 3. Write the AppleScript to a temporary .scpt file
    const asPath = path.join(os.tmpdir(), `ai_runner_${Date.now()}.scpt`);
    fs.writeFileSync(asPath, appleScript, 'utf8');

    // 4. Execute the AppleScript via osascript
    exec(`osascript "${asPath}"`, (error, stdout, stderr) => {
      // Clean up temp files
      if (fs.existsSync(jsxPath)) fs.unlinkSync(jsxPath);
      if (fs.existsSync(asPath)) fs.unlinkSync(asPath);

      if (error) {
        console.error('AppleScript Error:', error);
        reject(error);
        return;
      }

      const output = stdout.trim();
      if (output.startsWith('ERROR:')) {
        reject(new Error(output));
      } else {
        try {
          const parsed = JSON.parse(output);
          if (parsed.layers) {
            parsed.layers.forEach(l => {
              l.name = decodeURIComponent(l.name);
              l.content = decodeURIComponent(l.content);
              l.layerName = decodeURIComponent(l.layerName);
            });
          }
          resolve(parsed);
        } catch (parseError) {
          console.error("Failed to parse JSON from Illustrator. Raw output:", output);
          resolve({ error: output });
        }
      }
    });
  });
}

/**
 * Fetches all text frames from the active Illustrator document.
 */
async function getIllustratorTextLayers() {
  const script = `
    (function() {
      if (app.documents.length === 0) {
        return '{"error": "No documents open in Illustrator."}';
      }
      
      var doc = app.activeDocument;
      var textFrames = doc.textFrames;
      var layersData = [];
      
      // Get active artboard coordinates
      var activeIndex = doc.artboards.getActiveArtboardIndex();
      var abRect = doc.artboards[activeIndex].artboardRect;
      var abLeft = abRect[0];
      var abTop = abRect[1];
      var abRight = abRect[2];
      var abBottom = abRect[3];
      var abWidth = Math.abs(abRight - abLeft);
      var abHeight = Math.abs(abTop - abBottom);
      
      for (var i = 0; i < textFrames.length; i++) {
        var frame = textFrames[i];
        
        // Ensure frame is visible and on a visible layer
        if (frame.hidden || frame.layer.visible === false) continue;

        var bounds = frame.geometricBounds;
        
        // Map Illustrator coordinates to SVG screen coordinates (Origin top-left, Y goes down)
        var svgX = bounds[0] - abLeft;
        var svgY = abTop - bounds[1]; 
        var svgWidth = Math.abs(bounds[2] - bounds[0]);
        var svgHeight = Math.abs(bounds[1] - bounds[3]);
        
        layersData.push({
          id: frame.uuid || ('frame_' + i),
          name: frame.name || 'Text Frame ' + (i+1),
          content: frame.contents || '',
          layerName: frame.layer.name || '',
          bounds: {
            left: svgX,
            top: svgY,
            right: svgX + svgWidth,
            bottom: svgY + svgHeight,
            width: svgWidth,
            height: svgHeight
          }
        });
      }
      
      // Manual JSON stringification because ExtendScript is ES3 and lacks the JSON object
      var jsonLayers = [];
      for (var k = 0; k < layersData.length; k++) {
        var l = layersData[k];
        var safeContent = encodeURIComponent(l.content.toString());
        var safeName = encodeURIComponent(l.name.toString());
        var safeLayerName = encodeURIComponent(l.layerName.toString());
        var str = '{"id":"' + l.id + '","name":"' + safeName + '","content":"' + safeContent + '","layerName":"' + safeLayerName + '","bounds":{"left":' + l.bounds.left + ',"top":' + l.bounds.top + ',"right":' + l.bounds.right + ',"bottom":' + l.bounds.bottom + ',"width":' + l.bounds.width + ',"height":' + l.bounds.height + '}}';
        jsonLayers.push(str);
      }
      
      return '{"success":true, "docWidth":' + abWidth + ', "docHeight":' + abHeight + ', "layers":[' + jsonLayers.join(',') + ']}';
    })();
  `;

  return runExtendScript(script);
}

/**
 * Generates variations by duplicating the active document, replacing text, and saving a copy.
 */
async function generateIllustratorVariations(targetLayerId, dealersData) {
  const dealersJson = JSON.stringify(dealersData);
  
  // Note: ExtendScript uses older JS syntax. We pass data as a stringified JSON.
  const script = `
    (function() {
      try {
        if (app.documents.length === 0) return '{"error": "No documents open."}';
        
        var originalDoc = app.activeDocument;
        var dealers = eval('(' + '${dealersJson}' + ')');
        var generatedFiles = [];
        
        // Ensure a folder exists on desktop
        var desktopPath = Folder.desktop.fsName + "/BMW_Generated_Ads";
        var outFolder = new Folder(desktopPath);
        if (!outFolder.exists) outFolder.create();
        
        for (var i = 0; i < dealers.length; i++) {
          var dealer = dealers[i];
          
          // Duplicate the document to avoid modifying the original
          // (Illustrator scripting doesn't have a clean duplicateDoc, so we save a copy of current state, modify, save again)
          // Actually, let's just find the text frame, replace content, save a copy, then undo.
          
          var targetFrame = null;
          for (var j = 0; j < originalDoc.textFrames.length; j++) {
            if (originalDoc.textFrames[j].uuid === '${targetLayerId}' || 'frame_' + j === '${targetLayerId}') {
              targetFrame = originalDoc.textFrames[j];
              break;
            }
          }
          
          if (!targetFrame) return '{"error": "Could not find target layer in Illustrator."}';
          
          // Save original content for undo
          var originalContent = targetFrame.contents;
          
          // Construct new text
          var newText = dealer.name + "\\rTel: " + dealer.tel + "\\r" + dealer.location + "\\r" + dealer.url;
          targetFrame.contents = newText;
          
          // Save a copy
          var safeName = dealer.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
          var saveFile = new File(desktopPath + "/" + safeName + ".ai");
          
          var saveOpts = new IllustratorSaveOptions();
          saveOpts.pdfCompatible = true;
          originalDoc.saveAs(saveFile, saveOpts);
          
          generatedFiles.push(saveFile.fsName);
          
          // Revert content
          targetFrame.contents = originalContent;
        }
        
        // Use encodeURIComponent to safely transport paths
        var safeFiles = [];
        for (var f=0; f < generatedFiles.length; f++) {
          safeFiles.push('"' + encodeURIComponent(generatedFiles[f]) + '"');
        }
        
        return '{"success":true, "files":[' + safeFiles.join(',') + ']}';
      } catch(e) {
        var errStr = e.toString().replace(/"/g, '\\\\"').replace(/\\r|\\n/g, ' ');
        return '{"error":"' + errStr + '"}';
      }
    })();
  `;

  return runExtendScript(script).then(result => {
    if (result && result.files) {
      result.files = result.files.map(f => decodeURIComponent(f));
    }
    return result;
  });
}

module.exports = {
  getIllustratorTextLayers,
  generateIllustratorVariations
};
