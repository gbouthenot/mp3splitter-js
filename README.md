# Mp3splitter-js #
Split mp3 file by integrated chapters

The chapter information MUSE be included in ID3v2 tag.

## Usage ##
```node mp3splitter.js filetosplit.mp3```

## Dependencies ##
- [NodeJS](https://nodejs.org/en/download/)
- No javascript dependencies

## Compatiblility ##
Tested with nodejs v10.15.1 on linux x64 (should work on other platforms)

## Features##

### VBR Information ###
The generated files will include a VBR (ou CBR) frame header (a.k.a Xing header)

### ID3V2 tags handling ###
Splitted files keep the original tags except:
- Chapter information
- Embedded cover (only the first splitted file will have one)

The files gain the tags:
- Track number
- Total tracks
- Track title

Information used to split MUST be embedded in ID3V2 tags at the start of the file.

## Known issues ##
MP3 bit reservoir is not handled. This tool will not produce bit-perfect cuts. Use pcutmp3 if you want to achieve true gapless. This means that if you play the files produced in a gapless player, you may heard a very small 'click' between files. This is of course only relevant for cutting mp3 contained music.
