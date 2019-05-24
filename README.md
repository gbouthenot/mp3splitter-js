# mp3splitter
split mp3 file by integrated chapters

## Usage ##
node mp3splitter.js filetosplit.mp3

## Dependencies ##
- [NodeJS](https://nodejs.org/en/download/)
- No javascript dependencies

Tested with nodejs v10.15.1 on linux x64.

Should work on other platforms, too.

## ID3V2 tags handling ##

Splitted files keep the original tags except:
- Chapter information
- Embedded cover (only the first splitted file will have one)

The files gain the tags:
- Track number
- Total tracks
- Track title

Information used to split MUST be embedded in ID3V2 tags at the start of the file.

## Known issues ##
The MP3 files keep their VBR header, they will be incorrect.

If you use foobar2000, you should do Utilities -> rebuild mp3 stream and utilities -> Fix VBR header to have proper length information.
