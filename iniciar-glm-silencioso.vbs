' Lançador silencioso do GLM Raios (sem janela preta)
' Clique duas vezes neste arquivo para abrir o mapa

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Pasta onde está o script
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = pasta

porta = "8080"
url = "http://localhost:" & porta

' Verifica se Python existe
pythonCmd = ""
On Error Resume Next
WshShell.Run "python --version", 0, True
If Err.Number = 0 Then
    pythonCmd = "python"
Else
    Err.Clear
    WshShell.Run "py --version", 0, True
    If Err.Number = 0 Then
        pythonCmd = "py"
    End If
End If
On Error GoTo 0

If pythonCmd = "" Then
    MsgBox "Python nao encontrado!" & vbCrLf & vbCrLf & _
           "Instale em: https://www.python.org/downloads/" & vbCrLf & _
           "(marque a opcao 'Add Python to PATH')", vbCritical, "GLM Raios"
    WScript.Quit
End If

' Inicia o servidor minimizado
WshShell.Run pythonCmd & " -m pip install -q -r requirements.txt", 0, True
WshShell.Run pythonCmd & " glm_server.py " & porta, 0, False

' Espera o servidor subir
WScript.Sleep 1500

' Abre o navegador
WshShell.Run url

MsgBox "Mapa aberto no navegador!" & vbCrLf & vbCrLf & _
       "Para parar o servidor depois, abra o Gerenciador de Tarefas" & vbCrLf & _
       "e finalize o processo 'python.exe'.", vbInformation, "GLM Raios"
